//! The Web helper: a browser the agent drives through a few actions (goto, read,
//! click, type). It replaces the former Betterwright bridge. The bridge is this
//! same program started with `--browser-bridge`: a small HTTP API on 127.0.0.1
//! that the agent calls, and a headless Chrome (Chrome for Testing's
//! chrome-headless-shell) that it controls over the Chrome DevTools Protocol.
//!
//! Like the bridge it replaces, it refuses to load loopback, private and link-local
//! addresses, including through redirects, and it keeps one persistent profile.

use crate::{json_response, App};
use anyhow::{anyhow, bail, Context, Result};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    net::lookup_host,
    sync::{broadcast, mpsc, oneshot, Mutex},
};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

const ACTION_TIMEOUT: Duration = Duration::from_secs(45);
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const CLICK_SETTLE: Duration = Duration::from_secs(5);
const POLICY_TTL: Duration = Duration::from_secs(60);
const BINARY: &str = "chrome-headless-shell";

// ---- The Chrome DevTools Protocol, one connection to the browser ----

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct Cdp {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    events: broadcast::Sender<Value>,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
}

impl Cdp {
    async fn connect(url: &str) -> Result<Self> {
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .context("Couldn't connect to the browser.")?;
        let (mut sink, mut stream) = socket.split();
        let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(512);
        let closed = Arc::new(AtomicBool::new(false));
        tokio::spawn(async move {
            while let Some(text) = outgoing.recv().await {
                if sink.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
        });
        {
            let pending = pending.clone();
            let events = events.clone();
            let closed = closed.clone();
            tokio::spawn(async move {
                while let Some(Ok(message)) = stream.next().await {
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    match value.get("id").and_then(Value::as_u64) {
                        Some(id) => {
                            if let Some(reply) = pending.lock().await.remove(&id) {
                                let outcome = match value.get("error") {
                                    Some(error) => Err(error["message"]
                                        .as_str()
                                        .unwrap_or("The browser refused.")
                                        .to_owned()),
                                    None => Ok(value["result"].clone()),
                                };
                                let _ = reply.send(outcome);
                            }
                        }
                        None => {
                            let _ = events.send(value);
                        }
                    }
                }
                closed.store(true, Ordering::SeqCst);
                // Dropping the senders wakes every caller still waiting.
                pending.lock().await.clear();
            });
        }
        Ok(Self {
            out,
            pending,
            events,
            next: AtomicU64::new(1),
            closed,
        })
    }

    async fn call(&self, session: Option<&str>, method: &str, params: Value) -> Result<Value> {
        anyhow::ensure!(!self.closed.load(Ordering::SeqCst), "The browser closed.");
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (reply, answer) = oneshot::channel();
        self.pending.lock().await.insert(id, reply);
        let mut message = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        self.out
            .send(message.to_string())
            .map_err(|_| anyhow!("The browser closed."))?;
        let outcome = tokio::time::timeout(CALL_TIMEOUT, answer)
            .await
            .context("The browser didn't answer.")?
            .map_err(|_| anyhow!("The browser closed."))?;
        outcome.map_err(|message| anyhow!(message))
    }
}

// ---- The browser, its page and its network policy ----

struct Browser {
    child: tokio::process::Child,
    cdp: Arc<Cdp>,
    session: String,
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

/// Where the browser lives, once installed: data/bridge/browser/**/chrome-headless-shell.
fn find_binary(dir: &Path) -> Result<PathBuf> {
    walkdir::WalkDir::new(dir.join("browser"))
        .into_iter()
        .flatten()
        .map(|entry| entry.into_path())
        .find(|path| path.file_name().is_some_and(|name| name == BINARY) && path.is_file())
        .context("The Web helper's browser isn't installed yet.")
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (b & 0xc0) == 64))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// May the browser load this address? Checked for every request, redirects included.
async fn allowed(url: &str, cache: &Mutex<HashMap<String, (bool, Instant)>>) -> bool {
    let Ok(url) = url::Url::parse(url) else {
        return false;
    };
    match url.scheme() {
        "data" | "blob" | "about" => return true,
        "http" | "https" => {}
        _ => return false,
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return public_ip(ip);
    }
    if let Some((verdict, at)) = cache.lock().await.get(&bare) {
        if at.elapsed() < POLICY_TTL {
            return *verdict;
        }
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let verdict = match lookup_host((bare.as_str(), port)).await {
        Ok(addresses) => {
            let addresses: Vec<_> = addresses.collect();
            !addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip()))
        }
        Err(_) => false,
    };
    cache.lock().await.insert(bare, (verdict, Instant::now()));
    verdict
}

/// Decides every paused request: allowed ones continue, the rest fail as blocked by the client.
fn watch_requests(cdp: Arc<Cdp>, session: String) {
    let mut events = cdp.events.subscribe();
    let cache: Arc<Mutex<HashMap<String, (bool, Instant)>>> = Arc::new(Mutex::new(HashMap::new()));
    tokio::spawn(async move {
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            };
            if event["method"] != "Fetch.requestPaused" || event["sessionId"] != session.as_str() {
                continue;
            }
            let cdp = cdp.clone();
            let session = session.clone();
            let cache = cache.clone();
            tokio::spawn(async move {
                let request_id = event["params"]["requestId"].clone();
                let url = event["params"]["request"]["url"].as_str().unwrap_or("");
                let decision = if allowed(url, &cache).await {
                    cdp.call(
                        Some(&session),
                        "Fetch.continueRequest",
                        json!({"requestId": request_id}),
                    )
                    .await
                } else {
                    cdp.call(
                        Some(&session),
                        "Fetch.failRequest",
                        json!({"requestId": request_id, "errorReason": "BlockedByClient"}),
                    )
                    .await
                };
                let _ = decision;
            });
        }
    });
}

impl Browser {
    async fn launch(dir: &Path) -> Result<Self> {
        let binary = find_binary(dir)?;
        let profile = dir.join("profile");
        tokio::fs::create_dir_all(&profile).await?;
        let port_file = profile.join("DevToolsActivePort");
        let _ = tokio::fs::remove_file(&port_file).await;
        let mut command = tokio::process::Command::new(&binary);
        command
            .arg("--headless")
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.display()))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-sync",
                "--mute-audio",
                "--window-size=1280,900",
                "about:blank",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        // Chrome refuses to run as root without its sandbox turned off.
        if unsafe { libc::geteuid() } == 0 {
            command.arg("--no-sandbox");
        }
        let child = command
            .spawn()
            .context("Couldn't start the Web helper's browser.")?;
        let mut ready = None;
        for _ in 0..200 {
            if let Ok(text) = tokio::fs::read_to_string(&port_file).await {
                let lines: Vec<&str> = text.lines().collect();
                if lines.len() >= 2 {
                    ready = Some((lines[0].to_owned(), lines[1].to_owned()));
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let (port, path) = ready.context("The Web helper's browser didn't start.")?;
        let cdp = Arc::new(Cdp::connect(&format!("ws://127.0.0.1:{port}{path}")).await?);
        let target = cdp
            .call(None, "Target.createTarget", json!({"url": "about:blank"}))
            .await?;
        let attached = cdp
            .call(
                None,
                "Target.attachToTarget",
                json!({"targetId": target["targetId"], "flatten": true}),
            )
            .await?;
        let session = attached["sessionId"]
            .as_str()
            .context("The browser gave no page.")?
            .to_owned();
        for method in ["Page.enable", "Runtime.enable"] {
            cdp.call(Some(&session), method, json!({})).await?;
        }
        cdp.call(
            Some(&session),
            "Page.setLifecycleEventsEnabled",
            json!({"enabled": true}),
        )
        .await?;
        // Pause every request, so the policy sees it before the browser does.
        watch_requests(cdp.clone(), session.clone());
        cdp.call(
            Some(&session),
            "Fetch.enable",
            json!({"patterns": [{"urlPattern": "*", "requestStage": "Request"}]}),
        )
        .await?;
        Ok(Self {
            child,
            cdp,
            session,
        })
    }

    async fn eval(&self, expression: &str) -> Result<Value> {
        let reply = self
            .cdp
            .call(
                Some(&self.session),
                "Runtime.evaluate",
                json!({"expression": expression, "returnByValue": true, "awaitPromise": true}),
            )
            .await?;
        if let Some(details) = reply.get("exceptionDetails") {
            let message = details["exception"]["description"]
                .as_str()
                .or(details["text"].as_str())
                .unwrap_or("the page script failed");
            bail!("The page script failed: {message}");
        }
        Ok(reply["result"]["value"].clone())
    }

    /// Waits for a page lifecycle event, such as DOMContentLoaded, for this page.
    async fn settled(
        &self,
        mut events: broadcast::Receiver<Value>,
        name: &str,
        within: Duration,
    ) -> bool {
        let wait = async {
            loop {
                match events.recv().await {
                    Ok(event)
                        if event["method"] == "Page.lifecycleEvent"
                            && event["sessionId"] == self.session.as_str()
                            && event["params"]["name"] == name =>
                    {
                        return true
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return false,
                }
            }
        };
        tokio::time::timeout(within, wait).await.unwrap_or(false)
    }

    async fn read(&self, limit: usize) -> Result<String> {
        let script = format!(
            r#"(() => {{
const items = [...document.querySelectorAll('a,button,input,textarea,select,[role=button]')]
  .filter(e => e.offsetParent !== null).slice(0, 40)
  .map((e, i) => '[' + i + '] ' + e.tagName.toLowerCase() + ' ' +
    (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 60));
const text = (document.body ? document.body.innerText : '').replace(/\n{{2,}}/g, '\n').slice(0, {limit});
return 'Title: ' + document.title + '\nURL: ' + location.href + '\n\n' + text + '\n\nElements:\n' + items.join('\n');
}})()"#
        );
        Ok(self
            .eval(&script)
            .await?
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }

    /// Finds the element an agent named (a selector, or visible text, a button, a field or a label),
    /// scrolls it into view, and keeps it for the next step. Returns its centre.
    async fn find(&self, target: &str) -> Result<(f64, f64)> {
        let name = serde_json::to_string(target)?;
        let script = format!(
            r#"(() => {{
const t = {name}; const low = t.toLowerCase();
const visible = (e) => e.getClientRects().length > 0;
const pick = (list) => list.find(visible) || null;
const textOf = (e) => (e.textContent || '').toLowerCase();
let el = null;
if (/^[#.\[]|^\w+\[/.test(t)) {{ try {{ el = pick([...document.querySelectorAll(t)]); }} catch (e) {{}} }}
if (!el) el = pick([...document.querySelectorAll('body *')].filter(e => visible(e) && textOf(e).includes(low) &&
  ![...e.children].some(c => textOf(c).includes(low))));
if (!el) el = pick([...document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')]
  .filter(e => ((e.innerText || e.value || e.getAttribute('aria-label') || '')).toLowerCase().includes(low)));
if (!el) el = pick([...document.querySelectorAll('[placeholder]')]
  .filter(e => (e.getAttribute('placeholder') || '').toLowerCase().includes(low)));
if (!el) {{
  const label = [...document.querySelectorAll('label')].find(l => textOf(l).includes(low));
  if (label) el = label.control || (label.htmlFor && document.getElementById(label.htmlFor)) || label.querySelector('input,textarea,select');
}}
if (!el) return null;
window.__liquidTarget = el;
el.scrollIntoView({{block: 'center', inline: 'center'}});
const r = el.getBoundingClientRect();
if (!r.width || !r.height) return null;
return {{x: r.left + r.width / 2, y: r.top + r.height / 2}};
}})()"#
        );
        let point = self.eval(&script).await?;
        match (point["x"].as_f64(), point["y"].as_f64()) {
            (Some(x), Some(y)) => Ok((x, y)),
            _ => bail!("I couldn't find \"{target}\" on the page."),
        }
    }

    async fn click_at(&self, x: f64, y: f64) -> Result<()> {
        for (kind, extra) in [
            ("mouseMoved", json!({})),
            ("mousePressed", json!({"button": "left", "clickCount": 1})),
            ("mouseReleased", json!({"button": "left", "clickCount": 1})),
        ] {
            let mut params = json!({"type": kind, "x": x, "y": y});
            for (key, value) in extra.as_object().into_iter().flatten() {
                params[key] = value.clone();
            }
            self.cdp
                .call(Some(&self.session), "Input.dispatchMouseEvent", params)
                .await?;
        }
        Ok(())
    }

    async fn run(&self, action: &str, args: &Value, read_limit: usize) -> Result<String> {
        match action {
            "goto" => {
                let url = args["url"]
                    .as_str()
                    .context("Give a web address to open.")?;
                let loaded = self.cdp.events.subscribe();
                let navigation = self
                    .cdp
                    .call(Some(&self.session), "Page.navigate", json!({"url": url}))
                    .await?;
                if let Some(error) = navigation["errorText"].as_str() {
                    bail!("The page didn't open: {error}");
                }
                if !self.settled(loaded, "DOMContentLoaded", LOAD_TIMEOUT).await {
                    bail!("The page took too long to load.");
                }
                self.read(read_limit).await
            }
            "read" => self.read(read_limit).await,
            "click" => {
                let target = args["target"].as_str().context("Say what to click.")?;
                let (x, y) = self.find(target).await?;
                let loaded = self.cdp.events.subscribe();
                self.click_at(x, y).await?;
                // A click that opens a page settles in a moment; one that doesn't just times out.
                self.settled(loaded, "DOMContentLoaded", CLICK_SETTLE).await;
                self.read(read_limit).await
            }
            "type" => {
                let target = args["target"].as_str().context("Say where to type.")?;
                let text = args["text"].as_str().unwrap_or_default();
                self.find(target).await?;
                self.eval("(() => { const el = window.__liquidTarget; if (el) { el.focus(); if (el.select) el.select(); } return true; })()")
                    .await?;
                if text.is_empty() {
                    for kind in ["keyDown", "keyUp"] {
                        self.cdp
                            .call(
                                Some(&self.session),
                                "Input.dispatchKeyEvent",
                                json!({"type": kind, "key": "Delete", "code": "Delete", "windowsVirtualKeyCode": 46}),
                            )
                            .await?;
                    }
                } else {
                    self.cdp
                        .call(
                            Some(&self.session),
                            "Input.insertText",
                            json!({"text": text}),
                        )
                        .await?;
                }
                Ok("typed".to_owned())
            }
            other => bail!("Unknown browser action: {other}"),
        }
    }
}

// ---- The HTTP API the agent calls ----

struct Shared {
    token: String,
    dir: PathBuf,
    read_limit: usize,
    browser: Mutex<Option<Browser>>,
}

async fn perform(shared: &Shared, action: &str, args: &Value) -> Result<String> {
    let mut slot = shared.browser.lock().await;
    if slot
        .as_ref()
        .is_some_and(|browser| browser.cdp.closed.load(Ordering::SeqCst))
    {
        *slot = None;
    }
    if slot.is_none() {
        *slot = Some(Browser::launch(&shared.dir).await?);
    }
    let browser = slot.as_ref().expect("browser was just launched");
    browser.run(action, args, shared.read_limit).await
}

async fn handle(shared: &Shared, headers: &HeaderMap, body: &[u8], action: &str) -> Response {
    let token_ok = shared.token.is_empty()
        || headers
            .get("x-liquid-bridge-token")
            .and_then(|v| v.to_str().ok())
            == Some(shared.token.as_str());
    if !token_ok {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error": "unauthorized"}));
    }
    let args: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(body) {
            Ok(value) => value,
            Err(_) => return json_response(StatusCode::BAD_REQUEST, json!({"error": "Bad JSON."})),
        }
    };
    let reply = match tokio::time::timeout(ACTION_TIMEOUT, perform(shared, action, &args)).await {
        Ok(Ok(text)) => json!({"text": text}),
        Ok(Err(error)) => json!({"error": error.to_string()}),
        Err(_) => json!({"error": "The browser took too long."}),
    };
    json_response(StatusCode::OK, reply)
}

async fn health() -> Response {
    json_response(StatusCode::OK, json!({"ok": true}))
}

async fn goto(State(s): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    handle(&s, &headers, &body, "goto").await
}
async fn read(State(s): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    handle(&s, &headers, &body, "read").await
}
async fn click(State(s): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    handle(&s, &headers, &body, "click").await
}
async fn type_text(State(s): State<Arc<Shared>>, headers: HeaderMap, body: Bytes) -> Response {
    handle(&s, &headers, &body, "type").await
}

/// Runs the bridge until it is told to stop. Started by the server as `liquid-server --browser-bridge`.
pub async fn run() -> Result<()> {
    let port: u16 = std::env::var("LA_BROWSER_PORT")
        .unwrap_or_else(|_| "8767".into())
        .parse()?;
    let shared = Arc::new(Shared {
        token: std::env::var("LA_BROWSER_TOKEN").unwrap_or_default(),
        dir: std::env::var_os("LIQUID_AGENT_BROWSER_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("bridge")),
        read_limit: std::env::var("LA_READ_LIMIT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000),
        browser: Mutex::new(None),
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/goto", post(goto))
        .route("/read", post(read))
        .route("/click", post(click))
        .route("/type", post(type_text))
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!(
        "{}",
        liquid_core::i18n::diag_language()
            .bridge_ready
            .replace("{port}", &port.to_string())
    );
    let stop = CancellationToken::new();
    let stopping = stop.clone();
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        if let (Ok(mut term), Ok(mut hup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::hangup()),
        ) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
                _ = hup.recv() => {}
            }
        }
        stopping.cancel();
    });
    axum::serve(listener, app)
        .with_graceful_shutdown(async move { stop.cancelled().await })
        .await?;
    // Dropping the browser stops it.
    shared.browser.lock().await.take();
    Ok(())
}

// ---- Installing the browser ----

/// The Chrome for Testing build of chrome-headless-shell for this computer, if one exists.
fn platform() -> Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "aarch64") => "mac-arm64",
        ("macos", "x86_64") => "mac-x64",
        (os, arch) => bail!("The Web helper's browser isn't available on {os} {arch}."),
    })
}

/// Downloads Chrome for Testing's headless shell into data/bridge/browser.
pub async fn install(app: &App, cancel: &CancellationToken) -> Result<()> {
    let dir = app.data.join("bridge");
    tokio::fs::create_dir_all(&dir).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()?;
    let index_url = std::env::var("LIQUID_AGENT_BROWSER_INDEX").unwrap_or_else(|_| {
        "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
            .into()
    });
    let index: Value = client
        .get(index_url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let wanted = platform()?;
    let url = index["channels"]["Stable"]["downloads"]["chrome-headless-shell"]
        .as_array()
        .and_then(|list| list.iter().find(|item| item["platform"] == wanted))
        .and_then(|item| item["url"].as_str())
        .context("The browser download has no build for this computer.")?
        .to_owned();
    app.backends.set(
        app,
        "browser",
        json!({"status":"installing","text":"Downloading its browser…"}),
    );
    let archive = dir.join("browser.zip");
    let response = client.get(&url).send().await?.error_for_status()?;
    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&archive).await?;
    let mut got = 0u64;
    let mut shown = 0u64;
    use tokio::io::AsyncWriteExt;
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => bail!("Stopped."),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        got += chunk.len() as u64;
        if total > 0 && got * 100 / total >= shown + 10 {
            shown = got * 100 / total;
            app.backends.set(
                app,
                "browser",
                json!({"status":"installing","text":format!("Downloading its browser… {shown}%")}),
            );
        }
    }
    file.flush().await?;
    drop(file);
    app.backends.set(
        app,
        "browser",
        json!({"status":"installing","text":"Unpacking its browser…"}),
    );
    let target = dir.join("browser");
    let archive_path = archive.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&target)?;
        extract(&archive_path, &target)
    })
    .await??;
    let _ = tokio::fs::remove_file(&archive).await;
    anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    find_binary(&dir)?;
    tokio::fs::write(dir.join(".ready"), "").await?;
    Ok(())
}

fn extract(archive: &Path, into: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        let Some(relative) = entry.enclosed_name() else {
            continue; // refuse paths that leave the folder
        };
        let out = into.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut file)?;
        drop(file);
        use std::os::unix::fs::PermissionsExt;
        let mut mode = entry.unix_mode().unwrap_or(0o644) | 0o600;
        if out.file_name().is_some_and(|name| name == BINARY) {
            mode |= 0o755;
        }
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o777))?;
    }
    Ok(())
}
