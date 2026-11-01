//! Attachment storage compatible with the existing uploads index.
use crate::{json_response, response, store, App};
use axum::{
    body::to_bytes,
    extract::Request,
    http::{header, HeaderValue, Method, StatusCode},
    response::Response,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;
const MAX_UPLOAD: usize = 25 * 1024 * 1024;

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub(crate) fn public(record: &Value) -> Value {
    json!({"id":record["id"],"name":record["name"],"mime":record["mime"],"kind":record["kind"],"size":record["size"]})
}
pub(crate) fn path_for(data: &Path, record: &Value) -> Option<PathBuf> {
    let root = data.join("uploads").canonicalize().ok()?;
    let file = PathBuf::from(record.get("path")?.as_str()?)
        .canonicalize()
        .ok()?;
    (file.starts_with(root) && file.is_file()).then_some(file)
}

pub(crate) fn text_for(data: &Path, record: &Value, limit: usize) -> Option<String> {
    use std::io::Read;
    let original = path_for(data, record)?;
    let sidecar = PathBuf::from(format!("{}.txt", original.display()))
        .canonicalize()
        .ok()?;
    let root = data.join("uploads").canonicalize().ok()?;
    if !sidecar.starts_with(root) || !sidecar.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(sidecar)
        .ok()?
        .take((limit as u64).saturating_mul(4).saturating_add(4))
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Refuse paths outside the uploads folder, including links pointing elsewhere.
pub fn removal_paths(data: &Path, records: &[Value]) -> Result<Vec<PathBuf>, ()> {
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let root = data.join("uploads").canonicalize().map_err(|_| ())?;
    let mut paths = Vec::new();
    for record in records {
        let original = PathBuf::from(record.get("path").and_then(Value::as_str).ok_or(())?);
        match original.canonicalize() {
            Ok(path) if path.starts_with(&root) && path.is_file() => paths.push(path),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && original
                        .parent()
                        .and_then(|p| p.canonicalize().ok())
                        .as_deref()
                        == Some(root.as_path()) => {}
            _ => return Err(()),
        }
    }
    Ok(paths)
}
fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}
async fn run(command: &str, args: &[String], timeout: Duration) -> Option<Vec<u8>> {
    let mut child = Command::new(command);
    child.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, child.output())
        .await
        .ok()?
        .ok()?;
    output.status.success().then_some(output.stdout)
}
fn name(value: &str) -> String {
    let base = value.rsplit('/').next().unwrap_or("");
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_.- ()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}
fn known(ext: &str, list: &str) -> bool {
    list.split_whitespace().any(|x| x == ext)
}

pub(crate) async fn prepare(
    data: &Path,
    filename: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<Value, ()> {
    let id = store::id();
    let safe_name = name(filename);
    let ext = Path::new(&safe_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let dir = data.join("uploads");
    tokio::fs::create_dir_all(&dir).await.map_err(|_| ())?;
    let dir = dir.canonicalize().map_err(|_| ())?;
    let mut file = dir.join(format!(
        "{id}{}",
        if ext.is_empty() {
            String::new()
        } else {
            format!(".{ext}")
        }
    ));
    tokio::fs::write(&file, bytes).await.map_err(|_| ())?;
    let mut mime = if mime.is_empty() {
        match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "wav" => "audio/wav",
            "pdf" => "application/pdf",
            _ => "application/octet-stream",
        }
        .to_owned()
    } else {
        mime.to_owned()
    };
    let mut kind = "other";
    let mut text = None;
    if mime.starts_with("image/") || known(&ext,"png jpg jpeg gif webp heic bmp tiff") {
        kind = "image";
        if ["heic","tiff","bmp"].contains(&ext.as_str()) || mime == "image/heic" {
            let dest = dir.join(format!("{id}.png")); let src = file.to_string_lossy().to_string(); let out = dest.to_string_lossy().to_string();
            let converted = if cfg!(target_os = "macos") { run("sips", &["-s".into(),"format".into(),"png".into(),"-Z".into(),"1280".into(),src.clone(),"--out".into(),out.clone()],Duration::from_secs(60)).await.is_some() } else {
                let mut ok = false;
                for tool in ["magick","convert"] { if run(tool, &[format!("{src}[0]"),"-auto-orient".into(),"-resize".into(),"1280x1280>".into(),out.clone()],Duration::from_secs(60)).await.is_some() { ok=true; break; } }
                if !ok { ok = run("ffmpeg", &["-nostdin".into(),"-loglevel".into(),"error".into(),"-y".into(),"-i".into(),src.clone(),"-frames:v".into(),"1".into(),"-vf".into(),"scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease".into(),out.clone()],Duration::from_secs(60)).await.is_some(); }
                if !ok && ext == "heic" { ok = run("heif-convert", &[src.clone(),out.clone()],Duration::from_secs(60)).await.is_some(); }
                ok
            };
            if !converted { let _=tokio::fs::remove_file(&file).await; let _=tokio::fs::remove_file(&dest).await; return Err(()); }
            let _=tokio::fs::remove_file(&file).await; file=dest; mime="image/png".into();
        }
    } else if mime.starts_with("audio/") || ext == "wav" || known(&ext,"m4a mp3 aac aiff aif caf flac mp4 mov") {
        kind = "audio";
        if ext != "wav" {
            let dest = dir.join(format!("{id}.wav")); let src=file.to_string_lossy().to_string(); let out=dest.to_string_lossy().to_string();
            let converted = if cfg!(target_os="macos") { run("afconvert", &["-f".into(),"WAVE".into(),"-d".into(),"LEI16@16000".into(),"-c".into(),"1".into(),src,out],Duration::from_secs(300)).await } else { run("ffmpeg", &["-nostdin".into(),"-loglevel".into(),"error".into(),"-y".into(),"-i".into(),src,"-ac".into(),"1".into(),"-ar".into(),"16000".into(),"-c:a".into(),"pcm_s16le".into(),out],Duration::from_secs(300)).await };
            if converted.is_none() { let _=tokio::fs::remove_file(&file).await; let _=tokio::fs::remove_file(&dest).await; return Err(()); }
            let _=tokio::fs::remove_file(&file).await; file=dest; mime="audio/wav".into();
        }
    } else if mime.starts_with("text/") || known(&ext,"txt md markdown csv tsv json jsonl yaml yml toml xml html htm css js mjs cjs ts tsx jsx py rb go rs swift java kt c h cpp hpp cs php sh zsh bash sql log ini conf env tex srt vtt") {
        kind="text"; text=Some(String::from_utf8_lossy(bytes).into_owned());
    } else if known(&ext,"docx doc rtf rtfd odt webarchive pages") {
        let path=file.to_string_lossy().to_string(); let converted = if cfg!(target_os="macos") { run("textutil", &["-convert".into(),"txt".into(),"-stdout".into(),path],Duration::from_secs(600)).await } else { run("pandoc", &["-t".into(),"plain".into(),"--wrap=none".into(),path],Duration::from_secs(600)).await };
        if let Some(output)=converted { kind="text"; text=Some(String::from_utf8_lossy(&output).into_owned()); }
    }
    if let Some(text) = text {
        let sidecar = PathBuf::from(format!("{}.txt", file.display()));
        if tokio::fs::write(sidecar, text).await.is_err() {
            let _ = tokio::fs::remove_file(&file).await;
            return Err(());
        }
    }
    let size = tokio::fs::metadata(&file).await.map_err(|_| ())?.len();
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(
        json!({"id":id,"name":safe_name,"mime":mime,"kind":kind,"size":size,"path":file.to_string_lossy(),"at":at}),
    )
}

pub async fn handle(app: &App, request: Request, path: &str) -> Response {
    if path == "/api/uploads" && request.method() == Method::POST {
        let raw = request
            .headers()
            .get("x-file-name")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("file");
        let bytes = raw.as_bytes();
        let mut cursor = 0;
        while cursor < bytes.len() {
            if bytes[cursor] == b'%' {
                if cursor + 2 >= bytes.len()
                    || !bytes[cursor + 1].is_ascii_hexdigit()
                    || !bytes[cursor + 2].is_ascii_hexdigit()
                {
                    return error(StatusCode::BAD_REQUEST, "Bad request.");
                }
                cursor += 3;
            } else {
                cursor += 1;
            }
        }
        let filename = match percent_encoding::percent_decode_str(raw).decode_utf8() {
            Ok(name) => name.into_owned(),
            Err(_) => return error(StatusCode::BAD_REQUEST, "Bad request."),
        };
        let mime = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let bytes = match to_bytes(request.into_body(), MAX_UPLOAD).await {
            Ok(bytes) => bytes,
            Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too big."),
        };
        let record = match prepare(&app.data, &filename, &mime, &bytes).await {
            Ok(record) => record,
            Err(_) => {
                return error(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "I couldn't read that file.",
                )
            }
        };
        let mut index = app.uploads.lock().unwrap();
        let mut next = index.clone();
        next.insert(record["id"].as_str().unwrap().to_owned(), record.clone());
        if store::save(&app.data, "uploads.json", &Value::Object(next.clone())).is_err() {
            if let Some(file) = path_for(&app.data, &record) {
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_file(format!("{}.txt", file.display()));
            }
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Couldn't save the attachment.",
            );
        }
        *index = next;
        return json_response(StatusCode::OK, public(&record));
    }
    if request.method() == Method::GET {
        let Some(id) = path.strip_prefix("/api/uploads/").filter(|id| valid_id(id)) else {
            return error(StatusCode::NOT_FOUND, "Not found.");
        };
        let record = app.uploads.lock().unwrap().get(id).cloned();
        let Some(record) = record else {
            return error(StatusCode::NOT_FOUND, "Not found.");
        };
        let Some(file) = path_for(&app.data, &record) else {
            return error(StatusCode::NOT_FOUND, "Not found.");
        };
        let Ok(bytes) = tokio::fs::read(file).await else {
            return error(StatusCode::NOT_FOUND, "Not found.");
        };
        let mut res = response(StatusCode::OK, "application/octet-stream", bytes);
        if let Some(mime) = record
            .get("mime")
            .and_then(Value::as_str)
            .and_then(|v| HeaderValue::from_str(v).ok())
        {
            res.headers_mut().insert(header::CONTENT_TYPE, mime);
        }
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=86400"),
        );
        return res;
    }
    error(StatusCode::NOT_FOUND, "Not found.")
}
