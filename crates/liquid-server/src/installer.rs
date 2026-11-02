//! Download and install the local inference engine and model files.
use crate::{backends, json_response, App};
use anyhow::{bail, Context, Result};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct InstallState {
    pub busy: bool,
    pub queue: VecDeque<String>,
    pub current: Option<String>,
    pub cancel: Option<CancellationToken>,
    pub restart: HashSet<String>,
    pub suppress_start: HashSet<String>,
}
fn answer(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}
fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("liquid-agent/0.2")
        .connect_timeout(Duration::from_secs(15))
        .build()?)
}
pub(crate) fn hf_base() -> String {
    std::env::var("LIQUID_AGENT_HF_BASE")
        .ok()
        .filter(|s| liquid_core::settings::is_local(s))
        .unwrap_or_else(|| "https://huggingface.co".into())
        .trim_end_matches('/')
        .to_owned()
}
const ENGINE_TAG: &str = "b12017";
fn releases_url() -> String {
    std::env::var("LIQUID_AGENT_RELEASES_URL")
        .ok()
        .filter(|s| liquid_core::settings::is_local(s))
        .unwrap_or_else(|| {
            format!("https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{ENGINE_TAG}")
        })
}
fn emit(app: &App) {
    app.backends.emit(app);
}

pub async fn install(app: &App, request: Request) -> Response {
    let bytes = match to_bytes(request.into_body(), 1_000_000).await {
        Ok(v) => v,
        Err(_) => return answer(StatusCode::PAYLOAD_TOO_LARGE, "That request is too big."),
    };
    let value: Value = if bytes.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return answer(StatusCode::BAD_REQUEST, "Bad JSON."),
        }
    };
    let ids = value
        .get("ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    enqueue(app, &ids)
}

pub fn enqueue(app: &App, ids: &[Value]) -> Response {
    let settings = app.settings.lock().unwrap().clone();
    let mut state = app.backends.installs.lock().unwrap();
    if state
        .cancel
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
    {
        return answer(StatusCode::CONFLICT, "Wait for cancellation to finish.");
    }
    let mut requested: Vec<String> = ["engine", "small", "omni", "guardian", "browser"]
        .iter()
        .filter(|id| ids.iter().any(|v| v.as_str() == Some(**id)))
        .map(|s| s.to_string())
        .collect();
    if requested.iter().any(|id| id == "small" || id == "omni")
        && !backends::installed(&app.data, &settings, "engine")
        && !requested.iter().any(|id| id == "engine")
    {
        requested.insert(0, "engine".into());
    }
    for id in requested {
        if state.current.as_deref() != Some(&id) && !state.queue.contains(&id) {
            state.queue.push_back(id);
        }
    }
    if state.busy || state.queue.is_empty() {
        drop(state);
        emit(app);
        return json_response(StatusCode::OK, json!({"ok":true}));
    }
    state.busy = true;
    let cancel = CancellationToken::new();
    state.cancel = Some(cancel.clone());
    drop(state);
    emit(app);
    let app = app.clone();
    tokio::spawn(async move {
        run_queue(app, cancel).await;
    });
    json_response(StatusCode::OK, json!({"ok":true}))
}
pub fn cancel(app: &App) -> Response {
    let mut state = app.backends.installs.lock().unwrap();
    state.queue.clear();
    state.restart.clear();
    state.suppress_start.clear();
    if let Some(token) = &state.cancel {
        token.cancel();
    }
    drop(state);
    emit(app);
    json_response(StatusCode::OK, json!({"ok":true}))
}
fn store_custom(data: &Path) -> Option<Value> {
    let v = crate::store::load_or(data, "custom-model.json", Value::Null);
    if v.get("file").and_then(Value::as_str).is_some() {
        Some(v)
    } else {
        None
    }
}
/// New installs remain lazy when the selected policy or approval mode does not need them.
fn defer_model_start(app: &App, settings: &Value, id: &str, restart: bool) -> bool {
    if restart {
        return false;
    }
    if id == "guardian" && settings["approvalMode"] != "approveForMe" && !app.guardian_wanted() {
        return true;
    }
    match settings["startupMode"].as_str() {
        Some("single-omni") => matches!(id, "small" | "omni"),
        Some("hybrid") => id == "omni" || (id == "small" && app.backends.active("omni")),
        _ => false,
    }
}
fn schedule_deferred_text(app: &App, settings: &Value, id: &str, deferred: bool, suppressed: bool) {
    if deferred
        && !suppressed
        && id == "small"
        && settings["startupMode"] == "hybrid"
        && app.backends.active("omni")
    {
        backends::restore_text_when_idle(app.clone());
    }
}
async fn run_queue(app: App, cancel: CancellationToken) {
    loop {
        let id = {
            let mut s = app.backends.installs.lock().unwrap();
            if cancel.is_cancelled() {
                s.queue.clear();
            }
            let id = s.queue.pop_front();
            s.current = id.clone();
            if id.is_none() {
                s.busy = false;
                s.cancel = None;
            }
            id
        };
        let Some(id) = id else {
            emit(&app);
            return;
        };
        let settings = app.settings.lock().unwrap().clone();
        if backends::installed(&app.data, &settings, &id) {
            let (restart, mut suppressed) = {
                let mut state = app.backends.installs.lock().unwrap();
                (state.restart.remove(&id), state.suppress_start.remove(&id))
            };
            let _transition = if restart
                && app.backends.active(&id)
                && matches!(id.as_str(), "small" | "omni")
            {
                app.backends.set(
                    &app,
                    &id,
                    json!({"status":"installing","text":"Waiting for active work…","live":true}),
                );
                let Some(guard) = app.backends.transition_lock(&cancel).await else {
                    app.backends.set(&app, &id, json!({"status":if app.backends.running(&id) {"running"} else {"installed"}}));
                    break;
                };
                Some(guard)
            } else {
                None
            };
            suppressed |= app
                .backends
                .installs
                .lock()
                .unwrap()
                .suppress_start
                .remove(&id);
            if restart && app.backends.active(&id) {
                let _ = backends::stop_process(&app, &id).await;
            }
            let current_settings = app.settings.lock().unwrap().clone();
            let deferred = defer_model_start(&app, &current_settings, &id, restart);
            schedule_deferred_text(&app, &current_settings, &id, deferred, suppressed);
            if id != "engine"
                && id != "browser"
                && !deferred
                && !suppressed
                && !app.backends.active(&id)
            {
                let _ = backends::automatic_start(&app, &id, false, false).await;
            }
            continue;
        }
        if (id == "small" || id == "omni") && !backends::installed(&app.data, &settings, "engine") {
            app.backends.set(
                &app,
                &id,
                json!({"status":"failed","error":"Install the AI engine first."}),
            );
            continue;
        }
        let was_live = app.backends.running(&id);
        app.backends.set(
            &app,
            &id,
            json!({"status":"installing","text":"Starting…","live":was_live}),
        );
        let result = install_part(&app, &id, &settings, &cancel).await;
        if cancel.is_cancelled() {
            let live = app.backends.running(&id);
            app.backends.set(&app,&id,json!({"status":if live {"running"} else if backends::installed(&app.data,&settings,&id){"installed"}else{"missing"}}));
            break;
        }
        let (restart, mut suppressed) = {
            let mut state = app.backends.installs.lock().unwrap();
            (state.restart.remove(&id), state.suppress_start.remove(&id))
        };
        match result {
            Ok(()) => {
                let _transition = if restart
                    && app.backends.active(&id)
                    && matches!(id.as_str(), "small" | "omni")
                {
                    app.backends.set(&app, &id, json!({"status":"installing","text":"Waiting for active work…","live":true}));
                    let Some(guard) = app.backends.transition_lock(&cancel).await else {
                        app.backends.set(&app, &id, json!({"status":if app.backends.running(&id) {"running"} else {"installed"}}));
                        break;
                    };
                    Some(guard)
                } else {
                    None
                };
                suppressed |= app
                    .backends
                    .installs
                    .lock()
                    .unwrap()
                    .suppress_start
                    .remove(&id);
                if restart && app.backends.active(&id) {
                    let _ = backends::stop_process(&app, &id).await;
                }
                app.backends.set(&app, &id, json!({"status":"installed"}));
                let current_settings = app.settings.lock().unwrap().clone();
                let deferred = defer_model_start(&app, &current_settings, &id, restart);
                schedule_deferred_text(&app, &current_settings, &id, deferred, suppressed);
                if id != "engine" && id != "browser" && !deferred && !suppressed {
                    let response = backends::automatic_start(&app, &id, false, false).await;
                    if response.is_some_and(|response| !response.status().is_success()) {
                        app.backends.set(&app,&id,json!({"status":"failed","error":"The installed part could not be started."}));
                    }
                }
            }
            Err(error) => {
                let message = error.to_string().chars().take(300).collect::<String>();
                if app.backends.running(&id) {
                    app.backends.set(&app, &id, json!({"status":"running"}));
                    app.emit(
                        json!({"type":"notify","title":"Model download failed","body":message}),
                    );
                } else {
                    app.backends
                        .set(&app, &id, json!({"status":"failed","error":message}));
                }
            }
        }
    }
    {
        let mut s = app.backends.installs.lock().unwrap();
        s.busy = false;
        s.current = None;
        s.queue.clear();
        s.restart.clear();
        s.suppress_start.clear();
        s.cancel = None;
    }
    emit(&app);
}
async fn download(
    app: &App,
    id: &str,
    url: &str,
    dest: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    if dest.is_file() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let partial = PathBuf::from(format!("{}.part", dest.display()));
    let mut start = tokio::fs::metadata(&partial)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let client = client()?;
    let send = |start| {
        let mut req = client.get(url);
        if url.starts_with(&format!("{}/", hf_base())) {
            if let Some(token) = std::env::var("HF_TOKEN")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    std::env::var("HUGGING_FACE_HUB_TOKEN")
                        .ok()
                        .filter(|s| !s.is_empty())
                })
            {
                req = req.bearer_auth(token);
            }
        }
        if start > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={start}-"));
        }
        req.send()
    };
    let mut res =
        tokio::select! { _=cancel.cancelled()=>bail!("Cancelled"), result=send(start)=>result? };
    if res.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        start = 0;
        res = tokio::select! { _=cancel.cancelled()=>bail!("Cancelled"), result=send(0)=>result? };
    }
    if !res.status().is_success() {
        bail!("Download failed (HTTP {}).", res.status().as_u16());
    }
    if start > 0 && res.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let expected = format!("bytes {start}-");
        if !res
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|s| s.starts_with(&expected))
        {
            bail!("The download server returned an invalid range.");
        }
    } else {
        start = 0;
    }
    let remaining = res.content_length();
    let total = remaining.map(|n| n + start);
    let mut written = start;
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(start > 0)
        .truncate(start == 0)
        .open(&partial)
        .await?;
    let mut chunks = res.bytes_stream();
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    loop {
        let chunk =
            tokio::select! { _=cancel.cancelled()=>bail!("Cancelled"), chunk=chunks.next()=>chunk };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        written += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            let mut state = json!({"status":"installing","text":format!("Downloading {:.1} MB",written as f64/1e6),"live":app.backends.running(id)});
            if let Some(total) = total.filter(|n| *n > 0) {
                state["fraction"] = json!((written as f64 / total as f64).min(1.0));
            }
            app.backends.set(app, id, state);
            last = std::time::Instant::now();
        }
    }
    file.flush().await?;
    drop(file);
    if total.is_some_and(|n| n != written) {
        bail!("The download ended early; retry to resume.");
    }
    tokio::fs::rename(partial, dest).await?;
    Ok(())
}
async fn install_part(
    app: &App,
    id: &str,
    settings: &Value,
    cancel: &CancellationToken,
) -> Result<()> {
    let base = hf_base();
    match id {
        "engine" => install_engine(app, cancel).await,
        "browser" => install_browser(app, cancel).await,
        "guardian" => {
            let dir = app.data.join("guardian");
            for file in ["config.json", "model.safetensors", "tokenizer.json"] {
                download(
                    app,
                    id,
                    &format!("{base}/ProCreations/auto-150m-3/resolve/main/{file}"),
                    &dir.join(file),
                    cancel,
                )
                .await?;
            }
            tokio::fs::write(dir.join(".ready"), "ProCreations/auto-150m-3").await?;
            Ok(())
        }
        "small" if store_custom(&app.data).is_some() => install_custom(app, cancel).await,
        "small" | "omni" => {
            let (repo, prefix, key) = if id == "small" {
                ("LiquidAI/LFM3-1.7B-GGUF", "LFM3-1.7B-", "smallQuant")
            } else {
                ("LiquidAI/LFM3-Omni-2B-GGUF", "LFM3-Omni-2B-", "omniQuant")
            };
            let quant = settings
                .get(key)
                .and_then(Value::as_str)
                .context("Invalid model size")?;
            let allowed = if id == "small" {
                vec!["QAD-Q4_0", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "F16"]
            } else {
                vec!["Q4_0", "Q4_K_M", "Q8_0", "F16"]
            };
            if !allowed.contains(&quant) {
                bail!("Invalid model size.");
            }
            let dir = app.data.join("models");
            if id == "omni" {
                let name = backends::projector_name(settings).context("Invalid projector size")?;
                download(
                    app,
                    id,
                    &format!("{base}/{repo}/resolve/main/{name}"),
                    &dir.join(name),
                    cancel,
                )
                .await?;
            }
            let file = format!("{prefix}{quant}.gguf");
            download(
                app,
                id,
                &format!("{base}/{repo}/resolve/main/{file}"),
                &dir.join(file),
                cancel,
            )
            .await
        }
        _ => bail!("Unsupported part."),
    }
}
async fn install_engine(app: &App, cancel: &CancellationToken) -> Result<()> {
    let client = client()?;
    let res = tokio::select! { _=cancel.cancelled()=>bail!("Cancelled"), r=client.get(releases_url()).header(reqwest::header::ACCEPT,"application/vnd.github+json").send()=>r? };
    if !res.status().is_success() {
        bail!("Couldn't reach GitHub (HTTP {}).", res.status().as_u16());
    }
    let releases: Value =
        tokio::select! { _=cancel.cancelled()=>bail!("Cancelled"), r=res.json()=>r? };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let cpu = if cfg!(windows) {
        format!("bin-win-cpu-{arch}.zip")
    } else {
        format!("bin-ubuntu-{arch}.tar.gz")
    };
    let vulkan = if cfg!(windows) {
        format!("bin-win-vulkan-{arch}.zip")
    } else {
        format!("bin-ubuntu-vulkan-{arch}.tar.gz")
    };
    let mac = format!("bin-macos-{arch}.tar.gz");
    let want_vulkan = !cfg!(target_os = "macos")
        && (std::env::var("LIQUID_AGENT_GPU").as_deref() == Ok("vulkan")
            || (std::env::var("LIQUID_AGENT_GPU").as_deref() != Ok("cpu")
                && Path::new("/dev/dri").is_dir()));
    anyhow::ensure!(
        releases["tag_name"] == ENGINE_TAG,
        "Unexpected llama.cpp release; expected {ENGINE_TAG}."
    );
    let assets = releases["assets"]
        .as_array()
        .context("Invalid engine release assets")?;
    let find = |suffix: &str| {
        assets
            .iter()
            .find(|a| {
                a["name"].as_str().is_some_and(|name| {
                    name.starts_with(&format!("llama-{ENGINE_TAG}-"))
                        && name.ends_with(suffix)
                        && name
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
                })
            })
            .cloned()
    };
    let asset = if cfg!(target_os = "macos") {
        find(&mac)
    } else if want_vulkan {
        find(&vulkan).or_else(|| find(&cpu))
    } else {
        find(&cpu)
    }
    .context("No compatible build in the pinned llama.cpp release.")?;
    let url = asset["browser_download_url"]
        .as_str()
        .context("Invalid engine download URL")?;
    let asset_name = asset["name"]
        .as_str()
        .context("Invalid asset name")?
        .to_owned();
    let archive = app.data.join("tools").join(&asset_name);
    download(app, "engine", url, &archive, cancel).await?;
    app.backends.set(
        app,
        "engine",
        json!({"status":"installing","text":"Unpacking…"}),
    );
    let stage = app.data.join("engine.installing");
    let data = app.data.clone();
    let token = cancel.clone();

    let archive_for_extract = archive.clone();
    let extraction = tokio::task::spawn_blocking(move || -> Result<()> {
        if stage.exists() {
            std::fs::remove_dir_all(&stage)?;
        }
        std::fs::create_dir_all(&stage)?;
        if archive_for_extract
            .extension()
            .is_some_and(|ext| ext == "zip")
        {
            extract_engine_zip(&archive_for_extract, &stage, &token)?;
        } else {
            extract_engine_tar(&archive_for_extract, &stage, &token)?;
        }
        if token.is_cancelled() {
            bail!("Cancelled");
        }
        if !walkdir::WalkDir::new(&stage)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .any(|e| {
                e.file_type().is_file()
                    && e.file_name()
                        == if cfg!(windows) {
                            "llama-server.exe"
                        } else {
                            "llama-server"
                        }
            })
        {
            bail!("The download didn't contain llama-server.");
        }
        let target = data.join("engine");
        std::fs::write(
            stage.join(".flavor"),
            if asset_name.contains("vulkan") {
                "vulkan"
            } else if cfg!(target_os = "macos") {
                "metal"
            } else {
                "cpu"
            },
        )?;
        std::fs::write(stage.join(".version"), ENGINE_TAG)?;
        replace_engine(&stage, &target)?;
        let _ = std::fs::remove_file(&archive_for_extract);
        Ok(())
    })
    .await?;
    if extraction.is_err() && !cancel.is_cancelled() {
        let _ = tokio::fs::remove_file(&archive).await;
    }
    extraction?;
    Ok(())
}

fn extract_engine_tar(archive: &Path, stage: &Path, token: &CancellationToken) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(std::fs::File::open(archive)?);
    let mut tar = tar::Archive::new(decoder);
    let mut total = 0u64;
    for entry in tar.entries()? {
        anyhow::ensure!(!token.is_cancelled(), "Cancelled");
        let mut entry = entry?;
        let path = entry.path()?;
        anyhow::ensure!(
            path.components()
                .all(|c| matches!(c, Component::Normal(_) | Component::CurDir)),
            "Unsafe engine archive path."
        );
        if let Some(link) = entry.link_name()? {
            anyhow::ensure!(
                link.components()
                    .all(|c| matches!(c, Component::Normal(_) | Component::CurDir)),
                "Unsafe engine archive link."
            );
        }
        total = total
            .checked_add(entry.size())
            .context("Engine archive is too large")?;
        anyhow::ensure!(total <= 2_000_000_000, "Engine archive is too large.");
        anyhow::ensure!(entry.unpack_in(stage)?, "Unsafe engine archive entry.");
    }
    Ok(())
}

fn extract_engine_zip(archive: &Path, stage: &Path, token: &CancellationToken) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    let mut total = 0u64;
    for i in 0..zip.len() {
        anyhow::ensure!(!token.is_cancelled(), "Cancelled");
        let mut entry = zip.by_index(i)?;
        let path = entry
            .enclosed_name()
            .context("Unsafe engine archive path.")?;
        anyhow::ensure!(!entry.is_symlink(), "Unsafe engine archive entry.");
        total = total
            .checked_add(entry.size())
            .context("Engine archive is too large")?;
        anyhow::ensure!(total <= 2_000_000_000, "Engine archive is too large.");
        let dest = stage.join(path);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut file = std::fs::File::create(dest)?;
            std::io::copy(&mut entry, &mut file)?;
        }
    }
    Ok(())
}

fn replace_engine(stage: &Path, target: &Path) -> Result<()> {
    if !target.exists() {
        return Ok(std::fs::rename(stage, target)?);
    }
    let backup = target.with_file_name(format!("engine.backup-{}", crate::store::id()));
    std::fs::rename(target, &backup).context("Couldn't preserve the existing engine folder")?;
    if let Err(error) = std::fs::rename(stage, target) {
        std::fs::rename(&backup, target).context("Couldn't restore the previous engine folder")?;
        return Err(error.into());
    }
    Ok(())
}

async fn install_browser(app: &App, cancel: &CancellationToken) -> Result<()> {
    crate::browser_bridge::install(app, cancel).await
}

async fn install_custom(app: &App, cancel: &CancellationToken) -> Result<()> {
    let mut custom = store_custom(&app.data).context("No custom model selected")?;
    let repo = custom["repo"]
        .as_str()
        .context("Invalid model repository")?;
    let parsed = liquid_core::models::parse_hf_link(repo).map_err(anyhow::Error::msg)?;
    anyhow::ensure!(parsed["repo"] == repo, "Invalid model repository.");
    let revision = custom["revision"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("main");
    let file = custom["file"].as_str().context("Invalid model file")?;
    let variant = custom["variants"]
        .as_array()
        .context("Invalid model variants")?
        .iter()
        .find(|v| v["id"] == file)
        .context("Invalid model variant")?;
    anyhow::ensure!(
        crate::models::safe_variant(variant),
        "Invalid model variant."
    );
    let shards = variant["shards"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 1000)
        .context("Invalid model shards")?;
    let dir = app.data.join("models/custom");
    tokio::fs::create_dir_all(&dir).await?;
    anyhow::ensure!(
        tokio::fs::symlink_metadata(&dir)
            .await?
            .file_type()
            .is_dir(),
        "Unsafe model directory."
    );
    let root = dir.canonicalize()?;
    for shard in shards {
        let name = shard.as_str().context("Invalid shard")?;
        let path = Path::new(name);
        anyhow::ensure!(
            name.to_ascii_lowercase().ends_with(".gguf")
                && !path
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_))),
            "Unsafe model path."
        );
        let target = root.join(path);
        let parent = target.parent().context("Invalid model path")?;
        tokio::fs::create_dir_all(parent).await?;
        anyhow::ensure!(
            parent.canonicalize()?.starts_with(&root),
            "Unsafe model path."
        );
        for p in [
            &target,
            &PathBuf::from(format!("{}.part", target.display())),
        ] {
            if let Ok(meta) = tokio::fs::symlink_metadata(p).await {
                anyhow::ensure!(meta.file_type().is_file(), "Unsafe model path.");
            }
        }
        let mut url = url::Url::parse(&hf_base())?;
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("Invalid model URL"))?;
            segments.pop_if_empty();
            for part in repo.split('/') {
                segments.push(part);
            }
            segments.push("resolve").push(revision);
            for part in name.split('/') {
                segments.push(part);
            }
        }
        download(app, "small", url.as_str(), &target, cancel).await?;
    }
    let selected = root.join(file).canonicalize()?;
    anyhow::ensure!(selected.starts_with(&root), "Unsafe model path.");
    let meta = tokio::task::spawn_blocking(move || liquid_core::gguf::probe(selected)).await??;
    anyhow::ensure!(!cancel.is_cancelled(), "Cancelled");
    custom["meta"] = json!({"architecture":meta.architecture,"contextLength":meta.context_length,"hasTemplate":meta.has_template,"thinking":meta.thinking,"name":meta.name});
    crate::store::save(&app.data, "custom-model.json", &custom)?;
    Ok(())
}

#[cfg(test)]
mod engine_install_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extracts_windows_zip_and_preserves_previous_engine() -> Result<()> {
        let root = std::env::current_dir()?
            .join("target")
            .join(format!("engine-test-{}", crate::store::id()));
        std::fs::create_dir_all(&root)?;
        let archive = root.join("engine.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive)?);
        zip.start_file(
            "bin/llama-server.exe",
            zip::write::SimpleFileOptions::default(),
        )?;
        zip.write_all(b"windows engine")?;
        zip.finish()?;
        let stage = root.join("engine.installing");
        std::fs::create_dir(&stage)?;
        extract_engine_zip(&archive, &stage, &CancellationToken::new())?;
        let target = root.join("engine");
        std::fs::create_dir(&target)?;
        std::fs::write(target.join("old-file"), b"keep")?;
        replace_engine(&stage, &target)?;
        assert_eq!(
            std::fs::read(target.join("bin/llama-server.exe"))?,
            b"windows engine"
        );
        let backup = std::fs::read_dir(&root)?
            .filter_map(Result::ok)
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("engine.backup-")
            })
            .unwrap()
            .path();
        assert_eq!(std::fs::read(backup.join("old-file"))?, b"keep");
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn rejects_zip_path_traversal() -> Result<()> {
        let root = std::env::current_dir()?
            .join("target")
            .join(format!("engine-test-{}", crate::store::id()));
        std::fs::create_dir_all(&root)?;
        let archive = root.join("bad.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive)?);
        zip.start_file("../escape", zip::write::SimpleFileOptions::default())?;
        zip.write_all(b"bad")?;
        zip.finish()?;
        let stage = root.join("stage");
        std::fs::create_dir(&stage)?;
        assert!(extract_engine_zip(&archive, &stage, &CancellationToken::new()).is_err());
        assert!(!root.join("escape").exists());
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
