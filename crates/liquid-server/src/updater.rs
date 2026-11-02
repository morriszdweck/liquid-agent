//! Keeps an installed copy up to date by itself, with no npm or build step.
//!
//! Every push to main publishes a ready-to-run bundle as a GitHub release
//! (scripts/bundle.mjs). An installed copy carries build.json; a source checkout
//! has none and updates with git instead. A newer build downloads into
//! app.next beside the app and goes in once nothing is running: this server
//! starts a detached handover process (liquid-guardian --handover) that swaps
//! the folders, starts the new copy and puts the old one back if it doesn't come up.

use crate::{store, App};
use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::Ordering, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const IDLE_POLL: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct Status {
    state: &'static str,
    ready: Option<u64>,
    progress: u64,
    error: String,
    checked_at: u64,
    quiet_polls: u32,
}

pub struct Updater {
    root: PathBuf,
    pub build: Option<u64>,
    feed: String,
    managed: bool,
    status: Mutex<Status>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn sibling(root: &Path, suffix: &str) -> PathBuf {
    let mut name = root.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn remove_dir(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

/// The platform name used for bundled binaries, as install.sh names them ("darwin-arm64").
pub fn native() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    };
    let arch = if arch == "x86_64" { "x64" } else { arch };
    format!("{os}-{arch}")
}

/// The server binary a bundle ships in its bin folder.
pub fn server_binary_name() -> String {
    format!("liquid-server-{}", native())
}

#[cfg(unix)]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(windows)]
fn writable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| !m.permissions().readonly())
}

impl Updater {
    pub fn new(root: PathBuf) -> Self {
        let info = read_json(&root.join("build.json"));
        let build = info.as_ref().and_then(|v| v["build"].as_u64());
        let repo = info.and_then(|v| v["repo"].as_str().map(str::to_owned));
        let feed = std::env::var("LIQUID_AGENT_UPDATE_URL").unwrap_or_else(|_| {
            repo.map(|repo| {
                format!("https://github.com/{repo}/releases/latest/download/latest.json")
            })
            .unwrap_or_default()
        });
        let managed = build.is_some()
            && !feed.is_empty()
            && root.parent().is_some_and(|parent| writable(parent));
        Self {
            root,
            build,
            feed,
            managed,
            status: Mutex::new(Status {
                state: "idle",
                ready: None,
                progress: 0,
                error: String::new(),
                checked_at: 0,
                quiet_polls: 0,
            }),
        }
    }

    fn skip(&self, data: &Path) -> u64 {
        store::load_or(data, "update.json", json!({}))["skip"]
            .as_u64()
            .unwrap_or(0)
    }
}

fn idle(app: &App) -> bool {
    app.running.lock().unwrap().is_empty()
        && app.voice_calls.load(Ordering::SeqCst) == 0
        && !app.backends.busy()
}

pub fn snapshot(app: &App) -> Value {
    let u = &app.update;
    let s = u.status.lock().unwrap().clone();
    json!({
        "version": VERSION,
        "build": u.build,
        "managed": u.managed,
        "state": s.state,
        "ready": s.ready,
        "progress": s.progress,
        "error": s.error,
        "checkedAt": s.checked_at,
    })
}

fn update_status(app: &App, change: impl FnOnce(&mut Status)) {
    change(&mut app.update.status.lock().unwrap());
    app.emit(json!({"type":"update","update":snapshot(app)}));
}

fn auto_update(app: &App) -> bool {
    app.settings
        .lock()
        .unwrap()
        .get("autoUpdate")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Starts the background checks. Call once, after the server is listening.
pub fn start(app: &App) {
    let u = &app.update;
    if !u.managed {
        return;
    }
    remove_dir(&sibling(&u.root, ".download"));
    remove_dir(&sibling(&u.root, ".old"));
    // A build that started and failed was put back; don't try it again.
    let bad_root = sibling(&u.root, ".bad");
    if let Some(bad) = read_json(&bad_root.join("build.json")).and_then(|v| v["build"].as_u64()) {
        let mut saved = store::load_or(&app.data, "update.json", json!({}));
        saved["skip"] = json!(bad);
        let _ = store::save(&app.data, "update.json", &saved);
        remove_dir(&bad_root);
    }
    // A download from before a restart that never went in.
    let next = sibling(&u.root, ".next");
    let waiting = read_json(&next.join("build.json")).and_then(|v| v["build"].as_u64());
    let skip = u.skip(&app.data);
    match waiting {
        Some(waiting) if Some(waiting) > u.build && waiting != skip => {
            u.status.lock().unwrap().ready = Some(waiting);
            u.status.lock().unwrap().state = "ready";
        }
        _ => remove_dir(&next),
    }
    let checker = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            if auto_update(&checker) {
                let _ = check(&checker).await;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
    let poller = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_POLL).await;
            when_idle(&poller);
        }
    });
}

/// Looks for a newer build and downloads it.
pub async fn check(app: &App) -> Value {
    let u = &app.update;
    {
        let state = u.status.lock().unwrap().state;
        if !u.managed || ["checking", "downloading", "updating"].contains(&state) {
            return snapshot(app);
        }
    }
    update_status(app, |s| {
        s.state = "checking";
        s.error.clear();
    });
    let result = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()?;
        let res = client.get(&u.feed).send().await?;
        if !res.status().is_success() {
            bail!("Couldn't check for updates ({}).", res.status().as_u16());
        }
        let feed: Value = res.json().await?;
        Ok::<Value, anyhow::Error>(feed)
    }
    .await;
    match result {
        Ok(feed) => {
            let build = feed["build"].as_u64().unwrap_or(0);
            let current = u.build.unwrap_or(0);
            let ready = u.status.lock().unwrap().ready;
            let skip = u.skip(&app.data);
            if build <= current || build == skip {
                update_status(app, |s| {
                    s.state = if ready.is_some() { "ready" } else { "idle" };
                    s.checked_at = now_ms();
                });
            } else if ready != Some(build) {
                match download(app, &feed).await {
                    Ok(()) => update_status(app, |s| {
                        s.ready = Some(build);
                        s.state = "ready";
                        s.checked_at = now_ms();
                    }),
                    Err(e) => update_status(app, |s| {
                        s.state = if s.ready.is_some() { "ready" } else { "error" };
                        s.error = e.to_string().chars().take(200).collect();
                        s.checked_at = now_ms();
                    }),
                }
            } else {
                update_status(app, |s| {
                    s.state = "ready";
                    s.checked_at = now_ms();
                });
            }
        }
        Err(e) => {
            let timed_out = e
                .downcast_ref::<reqwest::Error>()
                .is_some_and(|e| e.is_timeout());
            let message = if timed_out {
                "Couldn't reach GitHub to check for updates.".to_owned()
            } else {
                e.to_string().chars().take(200).collect()
            };
            update_status(app, |s| {
                s.state = if s.ready.is_some() { "ready" } else { "error" };
                s.error = message;
            });
        }
    }
    snapshot(app)
}

async fn download(app: &App, feed: &Value) -> Result<()> {
    let u = &app.update;
    update_status(app, |s| {
        s.state = "downloading";
        s.progress = 0;
    });
    let staging = sibling(&u.root, ".download");
    remove_dir(&staging);
    fs::create_dir_all(&staging)?;
    let outcome = fetch_into(app, feed, &staging).await;
    remove_dir(&staging);
    outcome
}

async fn fetch_into(app: &App, feed: &Value, staging: &Path) -> Result<()> {
    let u = &app.update;
    let url = reqwest::Url::parse(&u.feed)?.join(
        feed["url"]
            .as_str()
            .context("The update has no download address.")?,
    )?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10 * 60))
        .build()?;
    let res = client.get(url).send().await?;
    if !res.status().is_success() {
        bail!("The update download failed ({}).", res.status().as_u16());
    }
    let archive = staging.join("liquid-agent.tar.gz");
    let mut file = fs::File::create(&archive)?;
    let total = feed["size"].as_u64().unwrap_or(0);
    let mut hasher = Sha256::new();
    let mut got = 0u64;
    let mut shown = 0u64;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk)?;
        got += chunk.len() as u64;
        let pct = if total > 0 { got * 100 / total } else { 0 };
        if pct >= shown + 5 {
            shown = pct;
            update_status(app, |s| s.progress = pct.min(100));
        }
    }
    file.flush()?;
    drop(file);
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if Some(digest.as_str()) != feed["sha256"].as_str() {
        bail!("The update didn't match its checksum, so it was thrown away.");
    }
    let dir = staging.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let file = fs::File::open(dir.join("liquid-agent.tar.gz"))?;
        tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(&dir)?;
        Ok(())
    })
    .await??;
    let unpacked = staging.join("liquid-agent");
    let build = read_json(&unpacked.join("build.json")).and_then(|v| v["build"].as_u64());
    if build != feed["build"].as_u64() || !unpacked.join("bin").join(server_binary_name()).is_file()
    {
        bail!("The update doesn't look like Liquid Agent, so it was thrown away.");
    }
    let next = sibling(&u.root, ".next");
    remove_dir(&next);
    fs::rename(&unpacked, &next)?;
    update_status(app, |s| s.progress = 100);
    Ok(())
}

/// Puts a downloaded build in once nothing has been running for a little while.
fn when_idle(app: &App) {
    let ready = {
        let s = app.update.status.lock().unwrap();
        s.state == "ready"
    };
    if !ready || !auto_update(app) {
        app.update.status.lock().unwrap().quiet_polls = 0;
        return;
    }
    let quiet = {
        let mut s = app.update.status.lock().unwrap();
        s.quiet_polls = if idle(app) { s.quiet_polls + 1 } else { 0 };
        s.quiet_polls
    };
    if quiet >= 2 {
        let _ = apply(app);
    }
}

/// Hands over to the downloaded build now.
pub fn apply(app: &App) -> Value {
    let u = &app.update;
    let next = sibling(&u.root, ".next");
    let ready_build = {
        let s = u.status.lock().unwrap();
        if s.state != "ready" || !next.exists() {
            return snapshot(app);
        }
        s.ready.unwrap_or(0)
    };
    update_status(app, |s| s.state = "updating");
    println!(
        "{}",
        liquid_core::i18n::diag_language()
            .updating
            .replace("{build}", &ready_build.to_string())
    );
    let guardian = u
        .root
        .join("bin")
        .join(format!("liquid-guardian-{}", native()));
    let log_path = app.data.join("logs").join("server.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|log| Ok((log.try_clone()?, log)));
    let started = (|| -> Result<()> {
        let (out, err) = log?;
        let args: Vec<String> = std::env::args().skip(1).filter(|a| a != "--open").collect();
        let mut command = Command::new(&guardian);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .arg("--handover")
            .arg(std::process::id().to_string())
            .arg(&u.root)
            .arg(server_binary_name())
            .arg(app.port.to_string())
            .arg(ready_build.to_string())
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()
            .with_context(|| format!("Couldn't restart to update: {}", guardian.display()))?;
        Ok(())
    })();
    if let Err(e) = started {
        update_status(app, |s| {
            s.state = "error";
            s.error = e.to_string();
        });
        return snapshot(app);
    }
    // Give the response time to go out, then stop this copy so the handover can swap it.
    let stopping = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        crate::shutdown(&stopping).await;
    });
    snapshot(app)
}
