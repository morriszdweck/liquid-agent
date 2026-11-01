//! Lifecycle for already-installed local inference processes.
use crate::{json_response, store, App};
use axum::{http::StatusCode, response::Response};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::Mutex as AsyncMutex,
};
use walkdir::WalkDir;

#[derive(Clone, Default)]
pub struct Backends {
    states: Arc<Mutex<HashMap<String, Value>>>,
    children: Arc<AsyncMutex<HashMap<String, Child>>>,
    pub(crate) installs: Arc<Mutex<crate::installer::InstallState>>,
}
const SMALL_QUANTS: &[(&str, &str, u64, &str)] = &[
    (
        "QAD-Q4_0",
        "Smallest",
        1_050_000_000,
        "Trained to stay sharp at 4-bit",
    ),
    ("Q4_K_M", "Balanced", 1_100_000_000, "Recommended"),
    ("Q5_K_M", "Sharper", 1_260_000_000, ""),
    ("Q6_K", "Sharper still", 1_430_000_000, ""),
    ("Q8_0", "Best", 1_850_000_000, "Near full quality"),
    (
        "F16",
        "Full quality",
        3_470_000_000,
        "Slowest, needs the most memory",
    ),
];
const OMNI_QUANTS: &[(&str, &str, u64, &str)] = &[
    ("Q4_0", "Smallest", 1_050_000_000, ""),
    ("Q4_K_M", "Balanced", 1_100_000_000, "Recommended"),
    ("Q8_0", "Best", 1_850_000_000, "Near full quality"),
    (
        "F16",
        "Full quality",
        3_470_000_000,
        "Slowest, needs the most memory",
    ),
];
pub(crate) fn gpu_flavor() -> &'static str {
    if cfg!(target_os = "macos") {
        "metal"
    } else if std::env::var("LIQUID_AGENT_GPU").as_deref() == Ok("cpu") {
        "cpu"
    } else if std::env::var("LIQUID_AGENT_GPU").as_deref() == Ok("vulkan")
        || Path::new("/dev/dri").is_dir()
    {
        "vulkan"
    } else {
        "cpu"
    }
}
pub(crate) fn memory_gb() -> u64 {
    #[cfg(target_os = "linux")]
    let bytes = unsafe {
        let pages = libc::sysconf(libc::_SC_PHYS_PAGES);
        let size = libc::sysconf(libc::_SC_PAGESIZE);
        if pages > 0 && size > 0 {
            (pages as u64).saturating_mul(size as u64)
        } else {
            0
        }
    };
    #[cfg(target_os = "macos")]
    let bytes = unsafe {
        let mut bytes = 0u64;
        let mut len = std::mem::size_of::<u64>();
        if libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            &mut bytes as *mut _ as *mut libc::c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        ) == 0
        {
            bytes
        } else {
            0
        }
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let bytes = 0u64;
    (bytes.saturating_add(1 << 29)) >> 30
}
pub(crate) fn engine(data: &Path) -> Option<PathBuf> {
    WalkDir::new(data.join("engine"))
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .find(|e| e.file_type().is_file() && e.file_name() == "llama-server")
        .map(|e| e.into_path())
}
fn guardian_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("LIQUID_AGENT_GUARDIAN_BINARY") {
        return Some(p.into());
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    [
        dir.join(format!("liquid-guardian-{platform}-{arch}")),
        dir.join("liquid-guardian"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}
fn safe_model(data: &Path, settings: &Value, id: &str) -> Option<(PathBuf, bool, usize, bool)> {
    if id == "small" {
        let custom = store::load_or(data, "custom-model.json", Value::Null);
        if let Some(file) = custom.get("file").and_then(Value::as_str) {
            if !custom.get("meta").is_some_and(Value::is_object) {
                return None;
            }
            let path = Path::new(file);
            if path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
                || !file.to_ascii_lowercase().ends_with(".gguf")
            {
                return None;
            }
            let root = data.join("models/custom").canonicalize().ok()?;
            let selected = root.join(path).canonicalize().ok()?;
            if !selected.starts_with(&root) || !selected.is_file() {
                return None;
            }
            let variant = custom
                .get("variants")?
                .as_array()?
                .iter()
                .find(|v| v.get("id").and_then(Value::as_str) == Some(file))?;
            let shards = variant.get("shards")?.as_array()?;
            if shards.is_empty()
                || !shards.iter().all(|v| {
                    v.as_str().is_some_and(|s| {
                        let p = Path::new(s);
                        !p.components().any(|c| !matches!(c, Component::Normal(_)))
                            && root
                                .join(p)
                                .canonicalize()
                                .is_ok_and(|p| p.starts_with(&root) && p.is_file())
                    })
                })
            {
                return None;
            }
            let context = custom
                .pointer("/meta/contextLength")
                .and_then(Value::as_u64)
                .map(|n| n.clamp(512, 32768) as usize)
                .unwrap_or(32768);
            let template = custom
                .pointer("/meta/hasTemplate")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            return Some((selected, true, context, template));
        }
    }
    let (prefix, key) = if id == "small" {
        ("LFM3-1.7B-", "smallQuant")
    } else {
        ("LFM3-Omni-2B-", "omniQuant")
    };
    let quant = settings.get(key)?.as_str()?;
    // A setting loaded from disk is untrusted even if a future settings patch is validated.
    if !quant
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return None;
    }
    let file = data.join("models").join(format!("{prefix}{quant}.gguf"));
    if !file.is_file()
        || (id == "omni" && !data.join("models/mmproj-LFM3-Omni-2B-Q8_0.gguf").is_file())
    {
        return None;
    }
    Some((file, false, 32768, true))
}
pub(crate) fn installed(data: &Path, settings: &Value, id: &str) -> bool {
    match id {
        "engine" => engine(data).is_some(),
        "small" | "omni" => safe_model(data, settings, id).is_some(),
        "guardian" => {
            ["config.json", "model.safetensors", "tokenizer.json"]
                .iter()
                .all(|f| data.join("guardian").join(f).is_file())
                && fs::read_to_string(data.join("guardian/.ready"))
                    .is_ok_and(|s| s.trim() == "ProCreations/auto-150m-3")
        }
        "browser" => data.join("bridge/.ready").is_file(),
        _ => false,
    }
}
pub(crate) fn port(id: &str) -> u16 {
    let (env, default) = match id {
        "small" => ("LIQUID_AGENT_SMALL_PORT", 8180),
        "omni" => ("LIQUID_AGENT_OMNI_PORT", 8181),
        "guardian" => ("LIQUID_GUARDIAN_PORT", 8766),
        _ => ("LIQUID_AGENT_BROWSER_PORT", 8767),
    };
    std::env::var(env)
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}
impl Backends {
    pub fn parts(&self, data: &Path, settings: &Value) -> Vec<Value> {
        let states = self.states.lock().unwrap();
        [
            (
                "engine",
                "AI engine",
                "Runs the models on your computer.",
                "about 30 MB",
            ),
            (
                "small",
                "Everyday brain",
                "LFM3 1.7B. Fast chat, writing and actions.",
                "1.1 GB",
            ),
            (
                "omni",
                "Eyes and ears",
                "LFM3 Omni 2B. Voice chat, pictures, your screen and audio.",
                "1.6 GB",
            ),
            (
                "guardian",
                "Safety helper",
                "Auto 150M. Checks each action is safe before it runs.",
                "about 300 MB",
            ),
            (
                "browser",
                "Web helper",
                "A headless Chrome. Lets the agent click around websites for you.",
                "about 250 MB",
            ),
        ]
        .into_iter()
        .map(|(id, title, detail, size)| {
            let state = states.get(id).cloned().unwrap_or_else(
                || json!({"status":if installed(data,settings,id){"installed"} else {"missing"}}),
            );
            let queued = self.installs.lock().unwrap().queue.iter().any(|v| v == id);
            let mut part =
                json!({"id":id,"title":title,"detail":detail,"size":size,"queued":queued});
            if id == "small" || id == "omni" {
                let (quants,prefix,key,extra) = if id=="small" {(SMALL_QUANTS,"LFM3-1.7B-","smallQuant",0u64)} else {(OMNI_QUANTS,"LFM3-Omni-2B-","omniQuant",540_000_000u64)};
                let selected=settings[key].as_str().unwrap_or("Q4_K_M");
                let bytes=quants.iter().find(|q|q.0==selected).map(|q|q.2+extra).unwrap_or(0);
                part["quant"]=json!(selected);part["bytes"]=json!(bytes);part["size"]=json!(format!("{:.1} GB",bytes as f64/1e9));
                part["quants"]=json!(quants.iter().map(|(qid,label,bytes,note)| {let mut q=json!({"id":qid,"label":label,"bytes":bytes,"size":format!("{:.1} GB",(*bytes+extra) as f64/1e9),"onDisk":data.join("models").join(format!("{prefix}{qid}.gguf")).is_file()});if !note.is_empty(){q["note"]=json!(note);}q}).collect::<Vec<_>>());
            }
            if id == "small" {
                let custom = store::load_or(data, "custom-model.json", Value::Null);
                if custom.get("file").and_then(Value::as_str).is_some() {
                    let bytes = custom["bytes"].as_f64().unwrap_or(0.0);
                    part["detail"] = json!(format!(
                        "{} · {}",
                        custom["label"].as_str().unwrap_or("Custom model"),
                        custom["repo"].as_str().unwrap_or("")
                    ));
                    part["size"] = json!(format!("{:.1} GB", bytes / 1e9));
                    part["bytes"] = json!(bytes);
                    part["quant"] = custom["file"].clone();
                    part["custom"] = custom.clone();
                    part["quants"] = json!(custom["variants"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|v| {
                            let mut v = v.clone();
                            v["size"] = json!(format!(
                                "{:.1} GB",
                                v["bytes"].as_f64().unwrap_or(0.0) / 1e9
                            ));
                            v["onDisk"] = json!(
                                v["id"] == custom["file"] && installed(data, settings, "small")
                            );
                            v
                        })
                        .collect::<Vec<_>>());
                }
            }
            if id != "engine" {
                part["port"] = json!(port(id));
            }
            if let Some(object) = state.as_object() {
                part.as_object_mut().unwrap().extend(object.clone());
            }
            part
        })
        .collect()
    }
    pub(crate) fn set(&self, app: &App, id: &str, state: Value) {
        let guardian_ready =
            id == "guardian" && state.get("status").and_then(Value::as_str) == Some("running");
        self.states.lock().unwrap().insert(id.into(), state);
        if guardian_ready {
            let mut settings = app.settings.lock().unwrap();
            if app.guardian_wanted() {
                let mut next = settings.clone();
                next["approvalMode"] = json!("approveForMe");
                match store::save(&app.data, "settings.json", &next)
                    .and_then(|_| app.set_guardian_wanted(false))
                {
                    Ok(()) => {
                        *settings = next.clone();
                        app.emit(json!({"type":"settings","settings":next}));
                    }
                    Err(error) => eprintln!("Could not activate the safety helper: {error}"),
                }
            }
        }
        self.emit(app);
    }
    pub(crate) fn emit(&self, app: &App) {
        let settings = app.settings.lock().unwrap().clone();
        app.emit(json!({"type":"parts","parts":self.parts(&app.data,&settings),"busy":self.busy(),"guardianWanted":app.guardian_wanted()}));
    }
    pub fn busy(&self) -> bool {
        self.installs.lock().unwrap().busy
    }
    pub fn active(&self, id: &str) -> bool {
        self.states.lock().unwrap().get(id).is_some_and(|v| {
            matches!(v["status"].as_str(), Some("running" | "starting"))
                || (v["status"] == "installing" && v["live"] == true)
        })
    }
    pub fn running(&self, id: &str) -> bool {
        self.states.lock().unwrap().get(id).is_some_and(|v| {
            v["status"] == "running" || (v["status"] == "installing" && v["live"] == true)
        })
    }
}
async fn health(port: u16) -> bool {
    let request = async {
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .ok()?;
        socket
            .write_all(format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes())
            .await
            .ok()?;
        let mut buf = [0u8; 128];
        let n = socket.read(&mut buf).await.ok()?;
        Some(
            String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200 ")
                || String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.0 200 "),
        )
    };
    tokio::time::timeout(Duration::from_secs(1), request)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}
fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}

pub async fn action(app: &App, id: &str, action: &str) -> Response {
    if action == "remove" {
        return remove(app, id).await;
    }
    if !["small", "omni", "guardian", "browser"].contains(&id) {
        return error(StatusCode::NOT_FOUND, "Not found or not yet supported.");
    }
    let backend = app.backends.clone();
    if action == "stop" {
        {
            let mut state = backend.installs.lock().unwrap();
            if state.current.as_deref() == Some(id) && state.busy {
                state.suppress_start.insert(id.to_owned());
            }
        }
        return stop_process(app, id).await;
    }
    if action != "start" {
        return error(StatusCode::NOT_FOUND, "Not found.");
    }
    let settings = app.settings.lock().unwrap().clone();
    if !installed(&app.data, &settings, id) {
        return error(StatusCode::CONFLICT, "This part is not installed.");
    }
    let mut children = backend.children.lock().await;
    if children.contains_key(id) {
        return json_response(StatusCode::OK, json!({"ok":true}));
    }
    let port = port(id);
    if tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .is_err()
    {
        // Only a leftover copy of this app's own helpers is replaced; anything else keeps its port.
        let freed = free_port(&app.data, port).await;
        if !freed
            || tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .is_err()
        {
            return error(
                StatusCode::CONFLICT,
                &format!("Something else is using port {port}."),
            );
        }
    }
    let mut command = if id == "browser" {
        // The Web helper's bridge is this same program, started in bridge mode.
        let Ok(program) = std::env::current_exe() else {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't find the server program to start the Web helper.",
            );
        };
        let mut c = Command::new(program);
        c.arg("--browser-bridge")
            .current_dir(app.data.join("bridge"))
            .env("LA_BROWSER_PORT", port.to_string())
            .env("LA_BROWSER_TOKEN", &app.token)
            .env("LIQUID_AGENT_BROWSER_DIR", app.data.join("bridge"));
        c
    } else if id == "guardian" {
        let Some(binary) = guardian_binary() else {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The Rust safety helper binary is missing.",
            );
        };
        let mut c = Command::new(binary);
        c.arg(app.data.join("guardian"))
            .arg(port.to_string())
            .arg("ProCreations/auto-150m-3");
        c
    } else {
        let Some(binary) = engine(&app.data) else {
            return error(StatusCode::CONFLICT, "The AI engine is not installed.");
        };
        let Some((weights, custom, context, template)) = safe_model(&app.data, &settings, id)
        else {
            return error(StatusCode::CONFLICT, "The model is not installed.");
        };
        let mut c = Command::new(binary);
        c.args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "-c",
            &context.to_string(),
            "-np",
            if custom { "1" } else { "2" },
            "-ngl",
            "99",
            "--reasoning",
            "auto",
        ]);
        if template {
            c.arg("--jinja");
        }
        if std::env::var("LIQUID_AGENT_GPU").as_deref() == Ok("cpu") {
            c.args(["--device", "none"]);
        }
        c.arg("-m").arg(weights).args([
            "--alias",
            if id == "small" {
                "LFM3-1.7B"
            } else {
                "LFM3-Omni-2B"
            },
        ]);
        if id == "omni" {
            c.arg("--mmproj")
                .arg(app.data.join("models/mmproj-LFM3-Omni-2B-Q8_0.gguf"));
        }
        c
    };
    if let Err(e) = fs::create_dir_all(app.data.join("logs")) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    let log = match fs::File::create(app.data.join("logs").join(format!("{id}.log"))) {
        Ok(log) => log,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let err = match log.try_clone() {
        Ok(log) => log,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err))
        .kill_on_drop(true);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let pid = child.id();
    children.insert(id.into(), child);
    drop(children);
    backend.set(app, id, json!({"status":"starting","text":"Waking up…"}));
    let app = app.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        let mut ready = false;
        let mut attempts = 0;
        loop {
            let mut children = app.backends.children.lock().await;
            let Some(child) = children.get_mut(&id) else {
                return;
            };
            if child.id() != pid {
                return;
            }
            if let Ok(Some(_)) = child.try_wait() {
                children.remove(&id);
                drop(children);
                app.backends.set(&app, &id, json!({"status":"failed","error":"The process exited; see its log for details."}));
                return;
            }
            drop(children);
            if !ready {
                if health(port).await {
                    let children = app.backends.children.lock().await;
                    if !children.get(&id).is_some_and(|child| child.id() == pid) {
                        return;
                    }
                    app.backends.set(&app, &id, json!({"status":"running"}));
                    drop(children);
                    ready = true;
                } else {
                    attempts += 1;
                    if attempts >= 240 {
                        let mut children = app.backends.children.lock().await;
                        if children.get(&id).is_some_and(|child| child.id() == pid) {
                            if let Some(mut child) = children.remove(&id) {
                                let _ = child.kill().await;
                            }
                            drop(children);
                            app.backends.set(&app, &id, json!({"status":"failed","error":"The process did not become ready; see its log for details."}));
                        }
                        return;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    json_response(StatusCode::OK, json!({"ok":true}))
}

/// Frees a port held by a leftover copy of this app's own helpers (after a crash, say).
/// Returns false, and touches nothing, if anything else holds it.
async fn free_port(data: &Path, port: u16) -> bool {
    let found = crate::platform::listeners(port).await;
    if found.is_empty() {
        return true;
    }
    let owned = data.to_string_lossy();
    if found
        .iter()
        .any(|(pid, command)| *pid == 0 || !command.contains(owned.as_ref()))
    {
        return false;
    }
    for (pid, _) in &found {
        unsafe {
            libc::kill(*pid as i32, libc::SIGTERM);
        }
    }
    tokio::time::sleep(Duration::from_millis(600)).await;
    true
}

/// Stops every model and helper this server started, so none is left running.
pub(crate) async fn stop_everything(app: &App) {
    let ids: Vec<String> = app.backends.children.lock().await.keys().cloned().collect();
    for id in ids {
        let _ = stop_process(app, &id).await;
    }
}

pub(crate) async fn stop_process(app: &App, id: &str) -> Response {
    let backend = app.backends.clone();
    if let Some(mut child) = backend.children.lock().await.remove(id) {
        if id == "browser" {
            // Asked to stop, the bridge closes its browser first; only a stuck one is killed.
            if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
            if tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        } else {
            let _ = child.kill().await;
        }
        let _ = child.wait().await;
    }
    let settings = app.settings.lock().unwrap().clone();
    backend.set(
        app,
        id,
        json!({"status":if installed(&app.data,&settings,id){"installed"}else{"missing"}}),
    );
    json_response(StatusCode::OK, json!({"ok":true}))
}
async fn remove(app: &App, id: &str) -> Response {
    if !["engine", "small", "omni", "guardian", "browser"].contains(&id) {
        return error(StatusCode::NOT_FOUND, "Not found.");
    }
    {
        let mut state = app.backends.installs.lock().unwrap();
        if state.busy {
            return error(
                StatusCode::CONFLICT,
                "Wait for the current download to finish.",
            );
        }
        state.busy = true;
    }
    let result: anyhow::Result<()> = async {
        if id == "guardian" {
            app.set_guardian_wanted(false)?;
            let mut settings = app.settings.lock().unwrap();
            if settings["approvalMode"] == "approveForMe" {
                let mut next = settings.clone();
                next["approvalMode"] = json!("askAlways");
                store::save(&app.data, "settings.json", &next)?;
                *settings = next.clone();
                app.emit(json!({"type":"settings","settings":next}));
            }
        }
        if id == "engine" {
            for model in ["small", "omni"] {
                let _ = Box::pin(action(app, model, "stop")).await;
            }
        } else {
            let _ = Box::pin(action(app, id, "stop")).await;
        }
        let remove_dir = |p: PathBuf| async move {
            match tokio::fs::symlink_metadata(&p).await {
                Ok(meta) if meta.file_type().is_symlink() => tokio::fs::remove_file(&p).await,
                Ok(_) => tokio::fs::remove_dir_all(&p).await,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }
        };
        match id {
            "engine" => remove_dir(app.data.join("engine")).await?,
            "guardian" => remove_dir(app.data.join("guardian")).await?,
            "browser" => remove_dir(app.data.join("bridge")).await?,
            "small" | "omni" => {
                if id == "small"
                    && store::load_or(&app.data, "custom-model.json", Value::Null)
                        .get("file")
                        .and_then(Value::as_str)
                        .is_some()
                {
                    remove_dir(app.data.join("models/custom")).await?;
                    match tokio::fs::remove_file(app.data.join("custom-model.json")).await {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e.into()),
                    }
                } else {
                    let root = app.data.join("models");
                    match tokio::fs::read_dir(root).await {
                        Ok(mut entries) => {
                            while let Some(entry) = entries.next_entry().await? {
                                let name = entry.file_name().to_string_lossy().into_owned();
                                let prefix = if id == "small" {
                                    "LFM3-1.7B-"
                                } else {
                                    "LFM3-Omni-2B-"
                                };
                                if name.starts_with(prefix)
                                    || (id == "omni" && name.starts_with("mmproj-LFM3-Omni-2B-"))
                                {
                                    let meta = entry.file_type().await?;
                                    if meta.is_file() || meta.is_symlink() {
                                        tokio::fs::remove_file(entry.path()).await?;
                                    }
                                }
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e.into()),
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    .await;
    {
        app.backends.installs.lock().unwrap().busy = false;
    }
    let settings = app.settings.lock().unwrap().clone();
    app.backends.set(
        app,
        id,
        json!({"status":if installed(&app.data,&settings,id){"installed"}else{"missing"}}),
    );
    crate::installer::enqueue(app, &[]);
    match result {
        Ok(()) => json_response(StatusCode::OK, json!({"ok":true})),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}
