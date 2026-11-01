//! Liquid Agent's local web server: serves the web UI and its API on 127.0.0.1,
//! runs the agent, the models and the voice bridge, and keeps itself up to date.
mod agent_tools;
mod backends;
mod browser_bridge;
mod chat;
#[cfg(test)]
mod desktop_check;
mod guardian;
mod installer;
mod media;
mod models;
mod platform;
mod scheduler;
mod storage_api;
mod store;
mod tools;
mod updater;
mod uploads;
mod vision_tools;
mod voice;
mod web;
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::Response,
    routing::{any, get},
    Router,
};
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct App {
    port: u16,
    token: String,
    dist: PathBuf,
    data: PathBuf,
    settings: Arc<Mutex<Value>>,
    memory: Arc<Mutex<Vec<String>>>,
    routines: Arc<Mutex<Vec<Value>>>,
    reminders: Arc<Mutex<Vec<Value>>>,
    routine_runs: Arc<tokio::sync::Mutex<()>>,
    chats: Arc<Mutex<Vec<Value>>>,
    activity: Arc<Mutex<Vec<Value>>>,
    running: Arc<Mutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>>,
    approvals: Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    uploads: Arc<Mutex<serde_json::Map<String, Value>>>,
    backends: backends::Backends,
    guardian_wanted: Arc<std::sync::atomic::AtomicBool>,
    defaults: Value,
    choices: Value,
    events: tokio::sync::broadcast::Sender<String>,
    update: Arc<updater::Updater>,
    voice_calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl App {
    fn guardian_wanted(&self) -> bool {
        self.guardian_wanted
            .load(std::sync::atomic::Ordering::SeqCst)
    }
    fn set_guardian_wanted(&self, value: bool) -> std::io::Result<()> {
        let mut saved = store::load_or(&self.data, "downloads.json", json!({}));
        if !saved.is_object() {
            saved = json!({});
        }
        saved["approveForMe"] = json!(value);
        store::save(&self.data, "downloads.json", &saved)?;
        self.guardian_wanted
            .store(value, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    fn emit(&self, event: Value) {
        let _ = self.events.send(event.to_string());
    }
    fn snapshot(&self) -> Value {
        let os = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        };
        let settings = self.settings.lock().unwrap().clone();
        let running: Vec<String> = self.running.lock().unwrap().keys().cloned().collect();
        json!({"chats":self.chats.lock().unwrap().clone(), "running":running,
            "settings":settings, "parts":self.backends.parts(&self.data, &settings), "busy":self.backends.busy(), "guardianWanted":self.guardian_wanted(),
            "machine":{"memoryGB":backends::memory_gb(),"os":os,"gpu":backends::gpu_flavor()}, "memory":self.memory.lock().unwrap().clone(),
            "ideas":store::load_or(&self.data,"ideas.json",json!({"at":0,"items":[]})),
            "routines":self.routines.lock().unwrap().clone(), "activity":self.activity.lock().unwrap().iter().take(200).cloned().collect::<Vec<_>>(),
            "reminders":self.reminders.lock().unwrap().clone(), "dataDir":self.data.to_string_lossy(),
            "update":updater::snapshot(self)})
    }
}

fn defaults(home: &str) -> Value {
    json!({"userName":"", "personality":"friendly", "approvalMode":"askAlways", "theme":"system", "voice":"female", "speakReplies":false, "autoUpdate":true, "workspace":home, "guardianThreshold":0.5, "contextBudget":6000, "toolOutputLimit":1200, "maxSteps":8, "temperature":0.3, "smallQuant":"Q4_K_M", "omniQuant":"Q4_K_M", "smallURL":"http://127.0.0.1:8180/v1", "omniURL":"http://127.0.0.1:8181/v1", "guardianURL":"http://127.0.0.1:8766", "browserURL":"http://127.0.0.1:8767"})
}
fn choices() -> Value {
    json!({"personality":["friendly","concise","playful","professional"], "approvalMode":["askAlways","approveForMe","fullAuto"], "theme":["system","light","dark"], "voice":["female","male"], "smallQuant":["QAD-Q4_0","Q4_K_M","Q5_K_M","Q6_K","Q8_0","F16"], "omniQuant":["Q4_0","Q4_K_M","Q8_0","F16"]})
}
fn response(status: StatusCode, content_type: &'static str, data: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(data.into())
        .unwrap()
}
fn json_response(status: StatusCode, value: Value) -> Response {
    response(status, "application/json", value.to_string())
}
fn allowed(headers: &HeaderMap, uri: &Uri, app: &App, token_required: bool) -> bool {
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host != format!("127.0.0.1:{}", app.port) && host != format!("localhost:{}", app.port) {
        return false;
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        let Ok(origin) = origin.to_str() else {
            return false;
        };
        if origin != format!("http://127.0.0.1:{}", app.port)
            && origin != format!("http://localhost:{}", app.port)
        {
            return false;
        }
    }
    if !token_required {
        return true;
    }
    let query_token = uri.query().and_then(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(key, _)| key == "t")
            .map(|(_, v)| v.into_owned())
    });
    let supplied = headers
        .get("x-liquid-token")
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned)
        .or(query_token)
        .unwrap_or_default();
    if supplied.len() != app.token.len() {
        return false;
    }
    supplied
        .bytes()
        .zip(app.token.bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
async fn route(State(app): State<App>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    if path == "/healthz" {
        return json_response(
            StatusCode::OK,
            json!({"app":"liquid-agent","build":app.update.build}),
        );
    }
    let api = path.starts_with("/api/");
    if !allowed(request.headers(), request.uri(), &app, api) {
        return json_response(
            if api {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::FORBIDDEN
            },
            json!({"error":"Not allowed."}),
        );
    }
    if api {
        if request.method() == Method::POST && path.starts_with("/api/approvals/") {
            return tools::approval(&app, request, &path).await;
        }
        if request.method() == Method::POST && path == "/api/screen" {
            let cancel = tokio_util::sync::CancellationToken::new();
            return match vision_tools::capture_screen(&cancel).await {
                Ok(png) => response(StatusCode::OK, "image/png", png),
                Err(e) => json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error":e.to_string()}),
                ),
            };
        }
        if request.method() == Method::POST && path == "/api/update/check" {
            return json_response(StatusCode::OK, updater::check(&app).await);
        }
        if request.method() == Method::POST && path == "/api/update/apply" {
            return json_response(StatusCode::OK, updater::apply(&app));
        }
        if request.method() == Method::POST && path == "/api/transcribe" {
            return media::transcribe(&app, request).await;
        }
        if request.method() == Method::POST && path == "/api/speak" {
            return media::speak(&app, request).await;
        }
        if path == "/api/models/custom" && request.method() == Method::DELETE {
            return models::change(&app, request, "clear").await;
        }
        if path == "/api/models/custom" && request.method() == Method::POST {
            return models::change(&app, request, "set").await;
        }
        if path == "/api/models/custom/quant" && request.method() == Method::POST {
            return models::change(&app, request, "quant").await;
        }
        if request.method() == Method::POST && path == "/api/models/resolve" {
            return models::handle(request).await;
        }
        if request.method() == Method::POST && path == "/api/reveal" {
            let cancel = tokio_util::sync::CancellationToken::new();
            return match platform::open_path(
                &app.data
                    .canonicalize()
                    .unwrap_or_else(|_| app.data.clone())
                    .to_string_lossy(),
                &cancel,
            )
            .await
            {
                Ok(()) => json_response(StatusCode::OK, json!({"ok":true})),
                Err(e) => json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error":e.to_string()}),
                ),
            };
        }
        if request.method() == Method::POST && path == "/api/parts/install" {
            return installer::install(&app, request).await;
        }
        if request.method() == Method::POST && path == "/api/parts/cancel" {
            return installer::cancel(&app);
        }
        if let Some(part) = path.strip_prefix("/api/parts/") {
            if request.method() == Method::POST {
                if let Some((id, action)) = part.split_once('/') {
                    return backends::action(&app, id, action).await;
                }
                return json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error":"Installing parts is not yet available in the Rust server."}),
                );
            }
        }
        if path == "/api/memory" || path.starts_with("/api/memory/") {
            return storage_api::memory(&app, request, &path).await;
        }
        if request.method() == Method::DELETE && path.starts_with("/api/reminders/") {
            return scheduler::delete_reminder(&app, path.trim_start_matches("/api/reminders/"));
        }
        if request.method() == Method::POST {
            if let Some(id) = path
                .strip_prefix("/api/routines/")
                .and_then(|s| s.strip_suffix("/run"))
            {
                return scheduler::run(&app, id, false).await;
            }
        }
        if path == "/api/routines" || path.starts_with("/api/routines/") {
            return storage_api::routines(&app, request, &path).await;
        }
        if path == "/api/uploads" || path.starts_with("/api/uploads/") {
            return uploads::handle(&app, request, &path).await;
        }
        if path == "/api/chats" || path.starts_with("/api/chats/") {
            return storage_api::chats(&app, request, &path).await;
        }
        return match (request.method(), path.as_str()) {
            (&Method::GET, "/api/ping") => json_response(StatusCode::OK, json!({"ok":true})),
            (&Method::GET, "/api/state") => json_response(StatusCode::OK, app.snapshot()),
            (&Method::GET, "/api/settings") => {
                json_response(StatusCode::OK, app.settings.lock().unwrap().clone())
            }
            (&Method::PATCH, "/api/settings") => {
                let bytes = match to_bytes(request.into_body(), 1_000_000).await {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        return json_response(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            json!({"error":"That request is too big."}),
                        )
                    }
                };
                let mut patch = if bytes.is_empty() {
                    json!({})
                } else {
                    match serde_json::from_slice::<Value>(&bytes) {
                        Ok(value) => value,
                        Err(_) => {
                            return json_response(
                                StatusCode::BAD_REQUEST,
                                json!({"error":"Bad JSON."}),
                            )
                        }
                    }
                };
                let mut settings = app.settings.lock().unwrap();
                if ["small", "omni"].iter().any(|id| {
                    patch
                        .get(format!("{id}Quant"))
                        .is_some_and(|value| settings.get(format!("{id}Quant")) != Some(value))
                }) && app.backends.busy()
                {
                    return json_response(
                        StatusCode::CONFLICT,
                        json!({"error":"Wait for the current download to finish, then pick a size."}),
                    );
                }
                let requested = patch.get("approvalMode").and_then(Value::as_str)
                    == Some("approveForMe")
                    && !app.backends.running("guardian");
                if requested {
                    if let Some(object) = patch.as_object_mut() {
                        object.remove("approvalMode");
                    }
                }
                if requested || patch.get("approvalMode").is_some() {
                    if let Err(error) = app.set_guardian_wanted(requested) {
                        return json_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            json!({"error":error.to_string()}),
                        );
                    }
                }
                let next =
                    liquid_core::settings::apply(&settings, &app.defaults, &app.choices, &patch);
                if let Err(error) = store::save(&app.data, "settings.json", &next) {
                    return json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        json!({"error":error.to_string()}),
                    );
                }
                let changed: Vec<&str> = ["small", "omni"]
                    .into_iter()
                    .filter(|id| {
                        settings.get(format!("{id}Quant")) != next.get(format!("{id}Quant"))
                    })
                    .collect();
                *settings = next.clone();
                drop(settings);
                app.emit(json!({"type":"settings","settings":next}));
                let mut install_ids = Vec::new();
                for id in changed {
                    let custom = id == "small"
                        && store::load_or(&app.data, "custom-model.json", Value::Null)
                            .get("file")
                            .and_then(Value::as_str)
                            .is_some();
                    let prefix = if id == "small" {
                        "LFM3-1.7B-"
                    } else {
                        "LFM3-Omni-2B-"
                    };
                    let had_model = std::fs::read_dir(app.data.join("models"))
                        .ok()
                        .into_iter()
                        .flatten()
                        .flatten()
                        .any(|entry| {
                            let name = entry.file_name().to_string_lossy().into_owned();
                            name.starts_with(prefix) && name.ends_with(".gguf")
                        });
                    if !custom && had_model {
                        app.backends
                            .installs
                            .lock()
                            .unwrap()
                            .restart
                            .insert(id.to_owned());
                        install_ids.push(json!(id));
                    }
                }
                if requested {
                    install_ids.push(json!("guardian"));
                }
                if !install_ids.is_empty() {
                    let queued = installer::enqueue(&app, &install_ids);
                    if !queued.status().is_success() {
                        if requested {
                            let _guard = app.settings.lock().unwrap();
                            let _ = app.set_guardian_wanted(false);
                        }
                        return queued;
                    }
                } else {
                    app.backends.emit(&app);
                }
                json_response(StatusCode::OK, next)
            }
            _ => json_response(StatusCode::NOT_FOUND, json!({"error":"Not found."})),
        };
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return json_response(StatusCode::NOT_FOUND, json!({"error":"Not found."}));
    }
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return json_response(StatusCode::BAD_REQUEST, json!({"error":"Bad request."}));
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    let decoded = match percent_encoding::percent_decode_str(&path).decode_utf8() {
        Ok(s) => s,
        Err(_) => return json_response(StatusCode::BAD_REQUEST, json!({"error":"Bad request."})),
    };
    let relative = decoded.trim_start_matches('/');
    if Path::new(relative)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        && !relative.is_empty()
    {
        return json_response(StatusCode::FORBIDDEN, json!({"error":"Forbidden."}));
    }
    let root = match app.dist.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain",
                "The web UI isn't built yet. Run: npm run build",
            )
        }
    };
    let candidate = root.join(relative);
    let file = match candidate.canonicalize() {
        Ok(p) if p.starts_with(&root) && p.is_file() => p,
        Ok(p) if !p.starts_with(&root) => {
            return json_response(StatusCode::FORBIDDEN, json!({"error":"Forbidden."}))
        }
        _ => match root.join("index.html").canonicalize() {
            Ok(p) if p.starts_with(&root) && p.is_file() => p,
            Ok(_) => return json_response(StatusCode::FORBIDDEN, json!({"error":"Forbidden."})),
            Err(_) => {
                return response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "text/plain",
                    "The web UI isn't built yet. Run: npm run build",
                )
            }
        },
    };
    let mut data = match fs::read(&file) {
        Ok(v) => v,
        Err(_) => {
            return response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain",
                "The web UI isn't built yet. Run: npm run build",
            )
        }
    };
    let ext = file.extension().and_then(|x| x.to_str()).unwrap_or("");
    let mime = match ext {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    };
    if ext == "html" {
        data = String::from_utf8_lossy(&data)
            .replace(
                "</head>",
                &format!(
                    "<meta name=\"liquid-token\" content=\"{}\"></head>",
                    app.token
                ),
            )
            .into_bytes();
    }
    let mut result = response(StatusCode::OK, mime, data);
    result
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if ext == "html" {
        result
            .headers_mut()
            .insert("x-frame-options", HeaderValue::from_static("DENY"));
        result.headers_mut().insert("content-security-policy", HeaderValue::from_static("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; worker-src 'self' blob:; frame-ancestors 'none'"));
    }
    result
}

async fn websocket(
    State(app): State<App>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    if !headers.contains_key(header::ORIGIN) || !allowed(&headers, &uri, &app, true) {
        return json_response(StatusCode::UNAUTHORIZED, json!({"error":"Not allowed."}));
    }
    ws.max_message_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| serve_socket(app, socket))
}

async fn serve_socket(app: App, mut socket: WebSocket) {
    let mut events = app.events.subscribe();
    let mut hello = app.snapshot();
    hello["type"] = json!("hello");
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            event = events.recv() => {
                let text = match event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => { let mut snapshot = app.snapshot(); snapshot["type"] = json!("hello"); snapshot.to_string() },
                    Err(_) => break,
                };
                if socket.send(Message::Text(text.into())).await.is_err() { break; }
            }
            message = socket.recv() => {
                if !matches!(message, Some(Ok(message)) if !matches!(message, Message::Close(_))) { break; }
            }
        }
    }
}

/// Where the app keeps its files: the same place the installer and the Mac app use.
fn data_dir() -> PathBuf {
    if let Some(dir) =
        env::var_os("LIQUID_AGENT_RUST_HOME").or_else(|| env::var_os("LIQUID_AGENT_HOME"))
    {
        return PathBuf::from(dir);
    }
    let home = PathBuf::from(env::var_os("HOME").unwrap_or_else(|| ".".into()));
    if cfg!(target_os = "macos") {
        return home.join("Library/Application Support/LiquidAgent");
    }
    let base = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    base.join("liquid-agent")
}

/// Stops the models and helpers, then exits. Used on Ctrl-C, SIGTERM, SIGHUP and updates.
pub(crate) async fn shutdown(app: &App) {
    backends::stop_everything(app).await;
    std::process::exit(0);
}

async fn wait_for_stop() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut hangup = signal(SignalKind::hangup()).expect("SIGHUP handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
        _ = hangup.recv() => {}
    }
}

/// Is a Liquid Agent already answering on this port?
async fn already_running(port: u16) -> bool {
    let Ok(res) = reqwest::get(format!("http://127.0.0.1:{port}/healthz")).await else {
        return false;
    };
    res.json::<Value>()
        .await
        .is_ok_and(|v| v["app"] == "liquid-agent")
}

/// The desktop app (Mac) or the web address, for `--open`.
async fn open_app(port: u16) {
    // Installers and tests run headless.
    if env::var_os("LIQUID_AGENT_NO_OPEN").is_some() {
        return;
    }
    let desktop = Path::new("/Applications/Liquid Agent.app");
    let target = if desktop.join("Contents/MacOS/Liquid Agent").exists() {
        desktop.to_string_lossy().into_owned()
    } else {
        format!("http://127.0.0.1:{port}")
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    if platform::open_path(&target, &cancel).await.is_err() {
        println!("Open {target} in your browser.");
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    // The Web helper's browser bridge runs as this same program.
    if args.first().map(String::as_str) == Some("--browser-bridge") {
        return browser_bridge::run()
            .await
            .map_err(|e| e.to_string().into());
    }
    let open = args.iter().any(|a| a == "--open");
    let port = env::var("LIQUID_AGENT_RUST_PORT")
        .or_else(|_| env::var("LIQUID_AGENT_PORT"))
        .unwrap_or_else(|_| "8170".into())
        .parse::<u16>()?;
    let data = data_dir();
    let root = env::var_os("LIQUID_AGENT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| ".".into()));
    let dist = env::var_os("LIQUID_AGENT_WEB_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("web/dist"));
    fs::create_dir_all(&data)?;
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    let defaults = defaults(&home);
    let mut settings = defaults.clone();
    if let Ok(bytes) = fs::read(data.join("settings.json")) {
        if let Ok(Value::Object(saved)) = serde_json::from_slice::<Value>(&bytes) {
            settings.as_object_mut().unwrap().extend(saved);
        }
    }
    let mut random = [0u8; 24];
    rand::rng().fill_bytes(&mut random);
    let token = random.iter().map(|b| format!("{b:02x}")).collect();
    let (events, _) = tokio::sync::broadcast::channel(256);
    let downloads = store::load_or(&data, "downloads.json", json!({}));
    let wanted = downloads
        .get("approveForMe")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let outdated = data.join("guardian/.ready").is_file()
        && !backends::installed(&data, &settings, "guardian");
    // Approve for Me needs the safety helper; without it, go back to asking.
    if settings["approvalMode"] == "approveForMe"
        && !wanted
        && !backends::installed(&data, &settings, "guardian")
    {
        settings["approvalMode"] = json!("askAlways");
        store::save(&data, "settings.json", &settings)?;
    }
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            if already_running(port).await {
                println!("Liquid Agent is already running at http://127.0.0.1:{port}");
                if open {
                    open_app(port).await;
                }
                std::process::exit(0);
            }
            eprintln!("Port {port} is in use by another program. Set LIQUID_AGENT_PORT to use a different port.");
            std::process::exit(1);
        }
        Err(e) => return Err(e.into()),
    };
    let app = App {
        port,
        token,
        dist,
        data: data.clone(),
        settings: Arc::new(Mutex::new(settings)),
        memory: Arc::new(Mutex::new(store::load_memory(&data)?)),
        routines: Arc::new(Mutex::new(store::load_routines(&data)?)),
        reminders: Arc::new(Mutex::new(
            store::load_or(&data, "reminders.json", json!([]))
                .as_array()
                .cloned()
                .unwrap_or_default(),
        )),
        routine_runs: Arc::new(tokio::sync::Mutex::new(())),
        chats: Arc::new(Mutex::new(store::load_chats(&data)?)),
        activity: Arc::new(Mutex::new(store::load_activity(&data)?)),
        running: Arc::new(Mutex::new(std::collections::HashMap::new())),
        approvals: Arc::new(Mutex::new(std::collections::HashMap::new())),
        uploads: Arc::new(Mutex::new(store::load_uploads(&data)?)),
        backends: backends::Backends::default(),
        guardian_wanted: Arc::new(std::sync::atomic::AtomicBool::new(wanted)),
        defaults,
        choices: choices(),
        events,
        update: Arc::new(updater::Updater::new(root)),
        voice_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };
    if wanted || outdated {
        let _ = installer::enqueue(&app, &[json!("guardian")]);
    }
    println!("Liquid Agent is running at http://127.0.0.1:{port}");
    println!("Data: {}", data.display());
    if open {
        open_app(port).await;
    }
    if std::env::var("LIQUID_AGENT_NO_AUTOSTART").as_deref() != Ok("1") {
        let started = app.clone();
        tokio::spawn(async move {
            for id in ["small", "omni", "guardian", "browser"] {
                let settings = started.settings.lock().unwrap().clone();
                if backends::installed(&started.data, &settings, id) {
                    let _ = backends::action(&started, id, "start").await;
                }
            }
        });
    }
    tokio::spawn(scheduler::worker(app.clone()));
    updater::start(&app);
    let stopping = app.clone();
    tokio::spawn(async move {
        wait_for_stop().await;
        shutdown(&stopping).await;
    });
    axum::serve(
        listener,
        Router::new()
            .route("/ws", get(websocket))
            .route("/voice", get(voice::websocket))
            .fallback(any(route))
            .with_state(app),
    )
    .await?;
    Ok(())
}
