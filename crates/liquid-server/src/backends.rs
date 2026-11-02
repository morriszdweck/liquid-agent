//! Lifecycle for already-installed local inference processes.
use crate::{json_response, store, App};
use axum::{http::StatusCode, response::Response};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
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
    pids: Arc<Mutex<HashMap<String, u32>>>,
    contexts: Arc<Mutex<HashMap<String, usize>>>,
    slots: Arc<Mutex<HashMap<String, usize>>>,
    manually_stopped: Arc<Mutex<HashSet<String>>>,
    children: Arc<AsyncMutex<HashMap<String, Child>>>,
    automatic_start: Arc<AsyncMutex<()>>,
    model_use: Arc<tokio::sync::RwLock<()>>,
    last_model_use: Arc<Mutex<Option<std::time::Instant>>>,
    pub(crate) installs: Arc<Mutex<crate::installer::InstallState>>,
}
pub(crate) struct ModelUseLease {
    _guard: tokio::sync::OwnedRwLockReadGuard<()>,
    last_used: Arc<Mutex<Option<std::time::Instant>>>,
}
impl Drop for ModelUseLease {
    fn drop(&mut self) {
        *self.last_used.lock().unwrap() = Some(std::time::Instant::now());
    }
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
    select_gpu_flavor(
        cfg!(target_os = "macos"),
        std::env::var("LIQUID_AGENT_GPU").ok().as_deref(),
        Path::new("/dev/dri").is_dir(),
    )
}
fn select_gpu_flavor(macos: bool, requested: Option<&str>, dri_present: bool) -> &'static str {
    if requested == Some("cpu") {
        "cpu"
    } else if macos {
        "metal"
    } else if requested == Some("vulkan") || dri_present {
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
/// Read Linux kernel kB counters without mistaking unavailable fields for zero.
fn proc_kb(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name != key {
            return None;
        }
        let mut words = value.split_whitespace();
        let number = words.next()?.parse::<u64>().ok()?;
        (words.next()? == "kB").then(|| number.saturating_mul(1024))
    })
}

fn cgroup_headroom(limit: &str, current: &str) -> Option<u64> {
    let limit = limit.trim().parse::<u64>().ok()?;
    let current = current.trim().parse::<u64>().ok()?;
    Some(limit.saturating_sub(current))
}

/// Best-effort cgroup v2 headroom, including limits on parent groups.
fn cgroup_available() -> Option<u64> {
    let membership = fs::read_to_string("/proc/self/cgroup").ok()?;
    cgroup_available_at(&membership, Path::new("/sys/fs/cgroup"))
}

fn cgroup_available_at(membership: &str, root: &Path) -> Option<u64> {
    let relative = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?;
    let path = Path::new(relative.trim_start_matches('/'));
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let mut dir = root.join(path);
    let mut available: Option<u64> = None;
    loop {
        if let (Ok(limit), Ok(current)) = (
            fs::read_to_string(dir.join("memory.max")),
            fs::read_to_string(dir.join("memory.current")),
        ) {
            if let Some(headroom) = cgroup_headroom(&limit, &current) {
                available = Some(available.map_or(headroom, |previous| previous.min(headroom)));
            }
        }
        if dir == root || !dir.pop() || !dir.starts_with(root) {
            break;
        }
    }
    available
}

pub(crate) fn system_memory() -> Value {
    let info = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let host_available = proc_kb(&info, "MemAvailable");
    let group_available = cgroup_available();
    let available = match (host_available, group_available) {
        (Some(host), Some(group)) => Some(host.min(group)),
        (Some(host), None) => Some(host),
        (None, Some(group)) => Some(group),
        (None, None) => None,
    };
    json!({"availableBytes":available,"cgroupAvailableBytes":group_available,"swapTotalBytes":proc_kb(&info,"SwapTotal"),"swapFreeBytes":proc_kb(&info,"SwapFree")})
}

fn process_memory(pid: u32) -> Option<Value> {
    let info = fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok()?;
    let private = proc_kb(&info, "Private_Clean")?.saturating_add(proc_kb(&info, "Private_Dirty")?);
    Some(
        json!({"pid":pid, "rssBytes":proc_kb(&info,"Rss"), "pssBytes":proc_kb(&info,"Pss"), "privateBytes":private, "swapBytes":proc_kb(&info,"Swap")}),
    )
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
pub(crate) fn projector_name(settings: &Value) -> Option<&'static str> {
    match settings["omniProjector"].as_str().unwrap_or("Q8_0") {
        "Q8_0" => Some("mmproj-LFM3-Omni-2B-Q8_0.gguf"),
        "Q4_K_M" => Some("mmproj-LFM3-Omni-2B-Q4_K_M.gguf"),
        _ => None,
    }
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
        || (id == "omni"
            && !projector_name(settings)
                .is_some_and(|name| data.join("models").join(name).is_file()))
    {
        return None;
    }
    let context = match settings["modelContext"].as_u64() {
        Some(8192) => 8192,
        Some(32768) => 32768,
        _ => 16384,
    };
    Some((file, false, context, true))
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
/// Automatic starts in low-memory mode favor Omni and never add a second large model.
/// Explicit starts remain available as an override. Do not evict an active request.
fn low_memory_mode(mode: &str, available: Option<u64>, total_gib: u64) -> bool {
    match mode {
        "single-omni" => true,
        "auto" => available
            .map(|bytes| bytes < 6 * 1024 * 1024 * 1024)
            .unwrap_or(total_gib == 0 || total_gib < 8),
        _ => false,
    }
}
pub(crate) fn auto_start_allowed(app: &App, settings: &Value, id: &str, prefer_omni: bool) -> bool {
    let limited = low_memory_mode(
        settings["startupMode"].as_str().unwrap_or("auto"),
        system_memory()["availableBytes"].as_u64(),
        memory_gb(),
    );
    if !limited || !matches!(id, "small" | "omni") {
        return true;
    }
    let other = if id == "small" { "omni" } else { "small" };
    if app.backends.active(other) {
        return false;
    }
    // Keep a text-only installation usable, but prefer Omni when both are installed.
    !prefer_omni || id != "small" || !installed(&app.data, settings, "omni")
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
    /// Hold a shared lease for the complete lifetime of a model operation, including its spawned work.
    pub(crate) fn begin_model_use(&self) -> Option<Arc<ModelUseLease>> {
        let guard = self.model_use.clone().try_read_owned().ok()?;
        *self.last_model_use.lock().unwrap() = Some(std::time::Instant::now());
        Some(Arc::new(ModelUseLease {
            _guard: guard,
            last_used: self.last_model_use.clone(),
        }))
    }
    pub(crate) async fn transition_lock(
        &self,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Option<tokio::sync::OwnedRwLockWriteGuard<()>> {
        tokio::select! { _ = cancel.cancelled() => None, guard = self.model_use.clone().write_owned() => Some(guard) }
    }
    /// Snapshot the server and direct child processes. Browser subprocesses and GPU allocations are not included.
    pub(crate) fn diagnostics(&self) -> Value {
        let mut processes = self
            .pids
            .lock()
            .unwrap()
            .iter()
            .map(|(id, pid)| {
                (
                    id.clone(),
                    process_memory(*pid).unwrap_or_else(|| json!({"pid":pid})),
                )
            })
            .collect::<serde_json::Map<String, Value>>();
        let pid = std::process::id();
        processes.insert(
            "server".into(),
            process_memory(pid).unwrap_or_else(|| json!({"pid":pid})),
        );
        json!({"system":system_memory(), "processes":processes, "gpuMemoryBytes":null})
    }
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
                let (quants,prefix,key,extra) = if id=="small" {(SMALL_QUANTS,"LFM3-1.7B-","smallQuant",0u64)} else {(OMNI_QUANTS,"LFM3-Omni-2B-","omniQuant",if settings["omniProjector"] == "Q4_K_M" {292_000_000u64} else {507_000_000u64})};
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
            if id == "omni" {
                let stopped = self.manually_stopped.lock().unwrap().contains("omni");
                let small_active = states.get("small").is_some_and(|v| matches!(v["status"].as_str(), Some("running" | "starting")) || (v["status"] == "installing" && v["live"] == true));
                let status = state["status"].as_str().unwrap_or("");
                part["onDemand"] = json!((settings["startupMode"] == "single-omni" && !small_active || matches!(settings["startupMode"].as_str(), Some("auto" | "hybrid"))) && !stopped && matches!(status, "installed" | "starting") && installed(data, settings, "omni") && installed(data, settings, "engine"));
            }
            if id == "engine" {
                if let Ok(version) = fs::read_to_string(data.join("engine/.version")) {
                    part["version"] = json!(version.trim());
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
                    Err(error) => eprintln!(
                        "{}",
                        liquid_core::i18n::diag_language()
                            .activate_safety
                            .replace("{error}", &error.to_string())
                    ),
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
    pub(crate) fn running_context(&self, id: &str) -> Option<usize> {
        self.running(id)
            .then(|| self.contexts.lock().unwrap().get(id).copied())
            .flatten()
    }
    pub(crate) fn running_slots(&self, id: &str) -> Option<usize> {
        self.running(id)
            .then(|| self.slots.lock().unwrap().get(id).copied())
            .flatten()
    }
}
/// Query read-only engine properties without waking a sleeping server. Missing fields stay unknown.
async fn engine_properties(id: &str) -> Option<Value> {
    let client = crate::media::client().ok()?;
    let response = client
        .get(format!("http://127.0.0.1:{}/props", port(id)))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.ok()?;
        if body.len() + bytes.len() > 1024 * 1024 {
            return None;
        }
        body.extend_from_slice(&bytes);
    }
    let value: Value = serde_json::from_slice(&body).ok()?;
    Some(
        json!({"build":value.get("build_info"),"sleeping":value.get("is_sleeping"),
        "slots":value.get("total_slots"),"context":value.pointer("/default_generation_settings/n_ctx"),
        "modalities":value.get("modalities")}),
    )
}

pub(crate) async fn diagnostic_snapshot(app: &App) -> Value {
    let mut result = app.backends.diagnostics();
    let (small, omni) = tokio::join!(
        async {
            if app.backends.running("small") {
                engine_properties("small").await
            } else {
                None
            }
        },
        async {
            if app.backends.running("omni") {
                engine_properties("omni").await
            } else {
                None
            }
        },
    );
    result["engineProperties"] = json!({"small":small,"omni":omni});
    result
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

/// Serialize policy checks and automatic starts so startup and installation cannot race.
pub(crate) async fn automatic_start(
    app: &App,
    id: &str,
    prefer_omni: bool,
    respect_stop: bool,
) -> Option<Response> {
    let _guard = app.backends.automatic_start.lock().await;
    let settings = app.settings.lock().unwrap().clone();
    if !auto_start_allowed(app, &settings, id, prefer_omni)
        || (respect_stop && app.backends.manually_stopped.lock().unwrap().contains(id))
        || app
            .backends
            .installs
            .lock()
            .unwrap()
            .suppress_start
            .contains(id)
    {
        return None;
    }
    Some(action_inner(app, id, "start").await)
}

/// Whether a vision tool can use Omni now or start it under an on-demand policy.
pub(crate) fn omni_available(app: &App) -> bool {
    if app.backends.running("omni") {
        return true;
    }
    if app
        .backends
        .manually_stopped
        .lock()
        .unwrap()
        .contains("omni")
    {
        return false;
    }
    let settings = app.settings.lock().unwrap().clone();
    if !matches!(settings["startupMode"].as_str(), Some("auto" | "hybrid"))
        || !installed(&app.data, &settings, "omni")
        || !installed(&app.data, &settings, "engine")
    {
        return false;
    }
    let states = app.backends.states.lock().unwrap();
    states
        .get("omni")
        .is_none_or(|s| matches!(s["status"].as_str(), Some("installed" | "starting")))
}

/// Browser tools can be offered before the helper is started, unless it was manually stopped or failed.
pub(crate) fn browser_available(app: &App) -> bool {
    if app
        .backends
        .manually_stopped
        .lock()
        .unwrap()
        .contains("browser")
    {
        return false;
    }
    if app.backends.running("browser") {
        return true;
    }
    let settings = app.settings.lock().unwrap().clone();
    if !installed(&app.data, &settings, "browser") {
        return false;
    }
    let states = app.backends.states.lock().unwrap();
    states
        .get("browser")
        .is_none_or(|state| matches!(state["status"].as_str(), Some("installed" | "starting")))
}

/// Start the helper only after a browser action is approved. A user stop suppresses restarts.
pub(crate) async fn demand_browser(
    app: &App,
    cancel: &tokio_util::sync::CancellationToken,
) -> bool {
    {
        let _guard = tokio::select! { _ = cancel.cancelled() => return false, guard = app.backends.automatic_start.lock() => guard };
        if !browser_available(app) {
            return false;
        }
        if !app.backends.active("browser")
            && !action_inner(app, "browser", "start")
                .await
                .status()
                .is_success()
        {
            return false;
        }
    }
    for _ in 0..600 {
        if app.backends.running("browser") {
            return true;
        }
        if !app.backends.active("browser") {
            return false;
        }
        tokio::select! { _ = cancel.cancelled() => return false, _ = tokio::time::sleep(Duration::from_millis(200)) => {} }
    }
    false
}

/// Conservative admission estimate. Unknown GPU headroom is treated as insufficient.
fn can_keep_both(app: &App, settings: &Value) -> bool {
    if settings["gpuLayers"].as_u64().unwrap_or(99) != 0 && gpu_flavor() != "cpu" {
        return false;
    }
    let Some((model, _, _, _)) = safe_model(&app.data, settings, "omni") else {
        return false;
    };
    let Some(projector) = projector_name(settings) else {
        return false;
    };
    let Some(bytes) = fs::metadata(model).ok().and_then(|m| {
        fs::metadata(app.data.join("models").join(projector))
            .ok()
            .map(|p| m.len().saturating_add(p.len()))
    }) else {
        return false;
    };
    system_memory()["availableBytes"]
        .as_u64()
        .is_some_and(|free| free >= bytes.saturating_add(1536 * 1024 * 1024))
}

/// Restore the text model after a period with no model operations. Never evict active work.
pub(crate) fn restore_text_when_idle(app: App) {
    *app.backends.last_model_use.lock().unwrap() = Some(std::time::Instant::now());
    tokio::spawn(async move {
        let idle = std::env::var("LIQUID_AGENT_HYBRID_IDLE_SECONDS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| (1..=3600).contains(s))
            .unwrap_or(300);
        loop {
            tokio::time::sleep(Duration::from_secs(idle.clamp(1, 5))).await;
            let settings = app.settings.lock().unwrap().clone();
            if !matches!(settings["startupMode"].as_str(), Some("auto" | "hybrid"))
                || !app.backends.active("omni")
                || app.backends.active("small")
                || app
                    .backends
                    .manually_stopped
                    .lock()
                    .unwrap()
                    .contains("small")
            {
                break;
            }
            let elapsed = app
                .backends
                .last_model_use
                .lock()
                .unwrap()
                .map(|t| t.elapsed())
                .unwrap_or_default();
            if elapsed < Duration::from_secs(idle) {
                continue;
            }
            let Ok(_transition) = app.backends.model_use.clone().try_write_owned() else {
                continue;
            };
            let _start = app.backends.automatic_start.lock().await;
            let settings = app.settings.lock().unwrap().clone();
            let elapsed = app
                .backends
                .last_model_use
                .lock()
                .unwrap()
                .map(|t| t.elapsed())
                .unwrap_or_default();
            if !matches!(settings["startupMode"].as_str(), Some("auto" | "hybrid"))
                || elapsed < Duration::from_secs(idle)
                || !app.backends.running("omni")
                || app.backends.active("small")
                || app
                    .backends
                    .manually_stopped
                    .lock()
                    .unwrap()
                    .contains("small")
                || !installed(&app.data, &settings, "small")
            {
                break;
            }
            let _ = stop_process(&app, "omni").await;
            if !action_inner(&app, "small", "start")
                .await
                .status()
                .is_success()
            {
                let _ = action_inner(&app, "omni", "start").await;
            } else {
                tokio::spawn(recover_after_text_warmup_failure(app.clone()));
            }
            break;
        }
    });
}

async fn recover_after_text_warmup_failure(app: App) {
    for _ in 0..1250 {
        if app.backends.running("small") {
            return;
        }
        let status = app
            .backends
            .states
            .lock()
            .unwrap()
            .get("small")
            .and_then(|s| s["status"].as_str().map(str::to_owned));
        if status.as_deref() == Some("failed") {
            let _transition = app.backends.model_use.clone().write_owned().await;
            let _guard = app.backends.automatic_start.lock().await;
            let settings = app.settings.lock().unwrap().clone();
            let stopped = app
                .backends
                .manually_stopped
                .lock()
                .unwrap()
                .contains("omni");
            if matches!(settings["startupMode"].as_str(), Some("auto" | "hybrid"))
                && !app.backends.active("small")
                && !app.backends.active("omni")
                && !stopped
                && installed(&app.data, &settings, "omni")
            {
                let _ = action_inner(&app, "omni", "start").await;
            }
            return;
        }
        if status.as_deref() != Some("starting") {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn restore_after_failed_omni(app: &App) {
    let _transition = app.backends.model_use.clone().write_owned().await;
    let _guard = app.backends.automatic_start.lock().await;
    let settings = app.settings.lock().unwrap().clone();
    if matches!(settings["startupMode"].as_str(), Some("auto" | "hybrid"))
        && !app.backends.active("omni")
        && !app.backends.active("small")
        && !app
            .backends
            .manually_stopped
            .lock()
            .unwrap()
            .contains("small")
        && installed(&app.data, &settings, "small")
    {
        let _ = action_inner(app, "small", "start").await;
    }
}

// A cancelled caller must not leave an evicted text model without recovery while
// the independently managed Omni process is still warming up.
async fn settle_cancelled_handoff(app: App) {
    for _ in 0..1250 {
        if app.backends.running("omni") {
            restore_text_when_idle(app);
            return;
        }
        if !app.backends.active("omni") {
            restore_after_failed_omni(&app).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    restore_after_failed_omni(&app).await;
}

/// Start Omni on demand; transitions wait for active model work before evicting text.
pub(crate) async fn demand_omni(app: &App) -> bool {
    demand_omni_cancellable(app, &tokio_util::sync::CancellationToken::new()).await
}

pub(crate) async fn demand_omni_cancellable(
    app: &App,
    cancel: &tokio_util::sync::CancellationToken,
) -> bool {
    if cancel.is_cancelled() {
        return false;
    }
    if app.backends.running("omni") {
        return true;
    }
    let settings = app.settings.lock().unwrap().clone();
    let mode = settings["startupMode"].as_str().unwrap_or("");
    if !["single-omni", "hybrid", "auto"].contains(&mode)
        || app
            .backends
            .manually_stopped
            .lock()
            .unwrap()
            .contains("omni")
        || !installed(&app.data, &settings, "omni")
        || !installed(&app.data, &settings, "engine")
    {
        return false;
    }
    let should_evict =
        mode != "single-omni" && app.backends.active("small") && !can_keep_both(app, &settings);
    let transition = if should_evict {
        tokio::select! {
            _ = cancel.cancelled() => return false,
            result = tokio::time::timeout(Duration::from_secs(120), app.backends.model_use.clone().write_owned()) => match result {
                Ok(guard) => Some(guard), Err(_) => return false,
            },
        }
    } else {
        None
    };
    let mut evicted = false;
    {
        let _guard = tokio::select! { _ = cancel.cancelled() => return false, guard = app.backends.automatic_start.lock() => guard };
        let settings = app.settings.lock().unwrap().clone();
        if cancel.is_cancelled()
            || settings["startupMode"] != mode
            || app
                .backends
                .manually_stopped
                .lock()
                .unwrap()
                .contains("omni")
            || !installed(&app.data, &settings, "omni")
        {
            return false;
        }
        if app.backends.active("small") {
            if mode == "single-omni" {
                return false;
            }
            if !can_keep_both(app, &settings) {
                if transition.is_none() {
                    return false;
                }
                let _ = stop_process(app, "small").await;
                evicted = true;
            }
        }
        if !app.backends.active("omni")
            && !action_inner(app, "omni", "start")
                .await
                .status()
                .is_success()
        {
            if evicted
                && !app
                    .backends
                    .manually_stopped
                    .lock()
                    .unwrap()
                    .contains("small")
            {
                let _ = action_inner(app, "small", "start").await;
            }
            return false;
        }
    }
    drop(transition);
    for _ in 0..1250 {
        if app.backends.running("omni") {
            if evicted {
                restore_text_when_idle(app.clone());
            }
            return true;
        }
        if !app.backends.active("omni") {
            if evicted {
                let app = app.clone();
                tokio::spawn(async move { restore_after_failed_omni(&app).await });
            }
            return false;
        }
        tokio::select! {
            _ = cancel.cancelled() => {
                if evicted {
                    tokio::spawn(settle_cancelled_handoff(app.clone()));
                }
                return false;
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }
    if evicted {
        let app = app.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            restore_after_failed_omni(&app).await;
        });
    }
    false
}

pub async fn action(app: &App, id: &str, action: &str) -> Response {
    if !["small", "omni", "guardian", "browser"].contains(&id)
        || !["start", "stop"].contains(&action)
    {
        return action_inner(app, id, action).await;
    }
    let _guard = app.backends.automatic_start.lock().await;
    if action == "stop" && ["small", "omni", "browser"].contains(&id) {
        app.backends
            .manually_stopped
            .lock()
            .unwrap()
            .insert(id.to_owned());
    } else {
        app.backends.manually_stopped.lock().unwrap().remove(id);
    }
    action_inner(app, id, action).await
}

async fn action_inner(app: &App, id: &str, action: &str) -> Response {
    action_inner_with_cpu(app, id, action, false).await
}

fn action_inner_with_cpu<'a>(
    app: &'a App,
    id: &'a str,
    action: &'a str,
    force_cpu: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Response> + Send + 'a>> {
    Box::pin(async move {
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
        let retry_on_cpu = !force_cpu
            && matches!(id, "small" | "omni")
            && settings["gpuLayers"].as_u64().unwrap_or(99) != 0
            && std::env::var("LIQUID_AGENT_GPU").as_deref() != Ok("cpu")
            && fs::read_to_string(app.data.join("engine/.flavor"))
                .is_ok_and(|f| matches!(f.trim(), "vulkan" | "metal"));
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
        let mut model_context = None;
        let mut model_slots = None;
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
            let Some((weights, _custom, context, template)) = safe_model(&app.data, &settings, id)
            else {
                return error(StatusCode::CONFLICT, "The model is not installed.");
            };
            let slots = if id == "omni" && settings["omniSlots"] == 2 {
                2
            } else {
                1
            };
            model_context = Some(context / slots);
            model_slots = Some(slots);
            let mut c = Command::new(binary);
            c.args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "-c",
                &context.to_string(),
                "-np",
                &slots.to_string(),
                "-ngl",
                &if force_cpu || std::env::var("LIQUID_AGENT_GPU").as_deref() == Ok("cpu") {
                    0
                } else {
                    match settings["gpuLayers"].as_u64() {
                        Some(0) => 0,
                        Some(16) => 16,
                        _ => 99,
                    }
                }
                .to_string(),
                "--reasoning",
                if id == "omni" { "off" } else { "auto" },
            ]);
            // Older engines ignore this environment variable rather than failing to start.
            let cache_mib = match settings["promptCacheMiB"].as_u64() {
                Some(0 | 1024 | 8192) => settings["promptCacheMiB"].as_u64().unwrap(),
                _ => 256,
            };
            c.env("LLAMA_ARG_CACHE_RAM", cache_mib.to_string());
            let sleep_minutes = match settings["idleSleepMinutes"].as_u64() {
                Some(5 | 15 | 30) => settings["idleSleepMinutes"].as_u64().unwrap(),
                _ => 0,
            };
            if sleep_minutes > 0 {
                c.args(["--sleep-idle-seconds", &(sleep_minutes * 60).to_string()]);
            }
            if template {
                c.arg("--jinja");
            }
            if force_cpu || std::env::var("LIQUID_AGENT_GPU").as_deref() == Ok("cpu") {
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
                let Some(projector) = projector_name(&settings) else {
                    return error(StatusCode::CONFLICT, "Invalid projector size.");
                };
                c.arg("--mmproj")
                    .arg(app.data.join("models").join(projector));
            }
            c
        };
        if let Err(e) = fs::create_dir_all(app.data.join("logs")) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
        let log_path = app.data.join("logs").join(format!("{id}.log"));
        let log = match if force_cpu {
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
        } else {
            fs::File::create(&log_path)
        } {
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
        if let Some(context) = model_context {
            backend
                .contexts
                .lock()
                .unwrap()
                .insert(id.to_owned(), context);
        }
        if let Some(slots) = model_slots {
            backend.slots.lock().unwrap().insert(id.to_owned(), slots);
        }
        if let Some(pid) = pid {
            backend.pids.lock().unwrap().insert(id.to_owned(), pid);
        }
        children.insert(id.into(), child);
        drop(children);
        backend.set(
            app,
            id,
            if force_cpu {
                json!({"status":"starting","text":"Retrying on CPU…","deviceFallback":"cpu"})
            } else {
                json!({"status":"starting","text":"Waking up…"})
            },
        );
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
                    app.backends.pids.lock().unwrap().remove(&id);
                    drop(children);
                    if !ready && retry_on_cpu {
                        retry_cpu(&app, &id, "The GPU process exited before becoming ready.").await;
                    } else {
                        app.backends.set(&app, &id, json!({"status":"failed","error":"The process exited; see its log for details."}));
                    }
                    return;
                }
                drop(children);
                if !ready {
                    if health(port).await {
                        let children = app.backends.children.lock().await;
                        if !children.get(&id).is_some_and(|child| child.id() == pid) {
                            return;
                        }
                        app.backends.set(
                            &app,
                            &id,
                            if force_cpu {
                                json!({"status":"running","deviceFallback":"cpu"})
                            } else {
                                json!({"status":"running"})
                            },
                        );
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
                                app.backends.pids.lock().unwrap().remove(&id);
                                drop(children);
                                if retry_on_cpu {
                                    retry_cpu(&app, &id, "The GPU process did not become ready.")
                                        .await;
                                } else {
                                    app.backends.set(&app, &id, json!({"status":"failed","error":"The process did not become ready; see its log for details."}));
                                }
                            }
                            return;
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
        json_response(StatusCode::OK, json!({"ok":true}))
    })
}

/// Retry one startup on the CPU. Do not revive a model the user stopped in the meantime.
async fn retry_cpu(app: &App, id: &str, reason: &str) {
    let _guard = app.backends.automatic_start.lock().await;
    if app.backends.manually_stopped.lock().unwrap().contains(id)
        || app.backends.children.lock().await.contains_key(id)
    {
        return;
    }
    app.backends.set(
        app,
        id,
        json!({"status":"starting","text":"Retrying on CPU…"}),
    );
    if !action_inner_with_cpu(app, id, "start", true)
        .await
        .status()
        .is_success()
    {
        app.backends.set(app, id, json!({"status":"failed","error":format!("{reason} CPU retry could not start; see the model log.")}));
    }
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
    let mut children = backend.children.lock().await;
    if let Some(mut child) = children.remove(id) {
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
    backend.pids.lock().unwrap().remove(id);
    drop(children);
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

#[cfg(test)]
mod resource_tests {
    use super::{
        cgroup_available_at, cgroup_headroom, low_memory_mode, proc_kb, select_gpu_flavor, Backends,
    };
    #[test]
    fn finite_cgroup_limit_provides_conservative_headroom() {
        assert_eq!(cgroup_headroom("1024\n", "256\n"), Some(768));
        assert_eq!(cgroup_headroom("1024", "2048"), Some(0));
        assert_eq!(cgroup_headroom("max", "256"), None);
        assert_eq!(cgroup_headroom("1024", "invalid"), None);
    }
    #[test]
    fn cgroup_parent_limit_is_considered() {
        let root = std::env::temp_dir().join(format!("liquid-cgroup-test-{}", std::process::id()));
        let child = root.join("parent/child");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(root.join("memory.max"), "max").unwrap();
        std::fs::write(root.join("memory.current"), "0").unwrap();
        std::fs::write(root.join("parent/memory.max"), "1000").unwrap();
        std::fs::write(root.join("parent/memory.current"), "800").unwrap();
        std::fs::write(child.join("memory.max"), "1000").unwrap();
        std::fs::write(child.join("memory.current"), "100").unwrap();
        assert_eq!(cgroup_available_at("0::/parent/child\n", &root), Some(200));
        assert_eq!(cgroup_available_at("0::/../escape\n", &root), None);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cpu_override_takes_precedence_on_macos_and_linux() {
        assert_eq!(select_gpu_flavor(true, Some("cpu"), true), "cpu");
        assert_eq!(select_gpu_flavor(false, Some("cpu"), true), "cpu");
        assert_eq!(select_gpu_flavor(true, None, false), "metal");
        assert_eq!(select_gpu_flavor(false, Some("vulkan"), false), "vulkan");
        assert_eq!(select_gpu_flavor(false, None, false), "cpu");
    }
    #[test]
    fn automatic_startup_accounts_for_available_memory() {
        let gib = 1024_u64 * 1024 * 1024;
        assert!(low_memory_mode("auto", Some(4 * gib), 32));
        assert!(!low_memory_mode("auto", Some(8 * gib), 32));
        assert!(low_memory_mode("auto", None, 0));
        assert!(low_memory_mode("single-omni", Some(32 * gib), 32));
        assert!(!low_memory_mode("dual", Some(gib), 4));
    }
    #[test]
    fn model_use_lease_prevents_an_exclusive_transition_until_all_clones_finish() {
        let backends = Backends::default();
        let lease = backends.begin_model_use().unwrap();
        let background = lease.clone();
        assert!(backends.model_use.clone().try_write_owned().is_err());
        drop(lease);
        assert!(backends.model_use.clone().try_write_owned().is_err());
        drop(background);
        assert!(backends.model_use.clone().try_write_owned().is_ok());
    }
    #[test]
    fn running_context_uses_the_launched_value_only_while_running() {
        let backends = Backends::default();
        backends
            .contexts
            .lock()
            .unwrap()
            .insert("small".into(), 8192);
        backends
            .states
            .lock()
            .unwrap()
            .insert("small".into(), serde_json::json!({"status":"running"}));
        assert_eq!(backends.running_context("small"), Some(8192));
        backends
            .states
            .lock()
            .unwrap()
            .insert("small".into(), serde_json::json!({"status":"installed"}));
        assert_eq!(backends.running_context("small"), None);
    }
    #[test]
    fn parses_proc_counters_and_preserves_missing_values() {
        let text = "MemAvailable:  1234 kB\nSwapFree: 0 kB\nBroken: x kB\n";
        assert_eq!(proc_kb(text, "MemAvailable"), Some(1234 * 1024));
        assert_eq!(proc_kb(text, "SwapFree"), Some(0));
        assert_eq!(proc_kb(text, "Broken"), None);
        assert_eq!(proc_kb(text, "Missing"), None);
    }
}
