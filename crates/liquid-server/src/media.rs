//! Dictation and speech through the local multimodal model.
use crate::{json_response, response, App};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}
fn client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build()?)
}
pub(crate) fn local_url(settings: &Value) -> Option<url::Url> {
    let text = settings.get("omniURL")?.as_str()?;
    let parsed = url::Url::parse(text).ok()?;
    (liquid_core::settings::is_local(text) && ["http", "https"].contains(&parsed.scheme()))
        .then_some(parsed)
}
pub(crate) async fn completion(url: &str, audio: &[u8]) -> anyhow::Result<String> {
    complete(url, json!([{"role":"system","content":"Perform ASR in English."},{"role":"user","content":[{"type":"input_audio","input_audio":{"data":BASE64.encode(audio),"format":"wav"}}]}]), 512).await
}
pub(crate) async fn vision(
    url: &str,
    image: &[u8],
    mime: &str,
    question: &str,
) -> anyhow::Result<String> {
    complete(url, json!([{"role":"user","content":[{"type":"image_url","image_url":{"url":format!("data:{mime};base64,{}",BASE64.encode(image))}},{"type":"text","text":question}]}]), 600).await
}
async fn complete(url: &str, messages: Value, max_tokens: u32) -> anyhow::Result<String> {
    let res=client()?.post(format!("{}/chat/completions",url.trim_end_matches('/'))).json(&json!({"model":"LFM3-Omni-2B","temperature":0,"max_tokens":max_tokens,"stream":true,"stream_options":{"include_usage":true},"cache_prompt":true,"chat_template_kwargs":{"enable_thinking":false},"messages":messages})).send().await?;
    anyhow::ensure!(
        res.status().is_success(),
        "Dictation failed (HTTP {}).",
        res.status().as_u16()
    );
    let mut stream = res.bytes_stream();
    let mut buffer = Vec::new();
    let mut text = String::new();
    'stream: while let Some(chunk) = stream.next().await {
        buffer.extend_from_slice(&chunk?);
        anyhow::ensure!(
            buffer.len() < 4 * 1024 * 1024,
            "The dictation response is too large."
        );
        while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
            let line = String::from_utf8_lossy(&buffer[..pos]).trim().to_owned();
            buffer.drain(..=pos);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                break 'stream;
            }
            if let Ok(event) = serde_json::from_str::<Value>(data) {
                if let Some(part) = event
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
                {
                    text.push_str(part);
                    anyhow::ensure!(
                        text.len() < 4 * 1024 * 1024,
                        "The dictation response is too large."
                    );
                }
            }
        }
    }
    let text = text.trim().strip_prefix(['"', '“']).unwrap_or(text.trim());
    Ok(text
        .strip_suffix(['"', '”'])
        .unwrap_or(text)
        .trim()
        .to_owned())
}
pub async fn transcribe(app: &App, request: Request) -> Response {
    if !app.backends.running("omni") {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Dictation needs Eyes and ears. Set it up in Settings → Downloads.",
        );
    }
    let settings = app.settings.lock().unwrap().clone();
    let Some(url) = local_url(&settings) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Refusing a model address that isn't on this computer.",
        );
    };
    let bytes = match to_bytes(request.into_body(), 25 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too big."),
    };
    match completion(url.as_str(), &bytes).await {
        Ok(text) => json_response(StatusCode::OK, json!({"text":text})),
        Err(e) => error(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}
pub async fn speak(app: &App, request: Request) -> Response {
    if !app.backends.running("omni") {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Reading aloud needs Eyes and ears. Set it up in Settings → Downloads.",
        );
    }
    let bytes = match to_bytes(request.into_body(), 1_000_000).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too big."),
    };
    let body: Value = if bytes.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return error(StatusCode::BAD_REQUEST, "Bad JSON."),
        }
    };
    let settings = app.settings.lock().unwrap().clone();
    let Some(url) = local_url(&settings) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Refusing a model address that isn't on this computer.",
        );
    };
    let text = body["text"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(1200)
        .collect::<String>();
    let voice = body["voice"]
        .as_str()
        .filter(|v| ["male", "female"].contains(v))
        .or_else(|| settings["voice"].as_str())
        .unwrap_or("female");
    let request = match client() {
        Ok(client) => client
            .post(format!("{}/tts", url.origin().ascii_serialization()))
            .json(&json!({"input":text,"voice":voice})),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let res = match request.send().await {
        Ok(res) => res,
        Err(e) => return error(StatusCode::BAD_GATEWAY, &e.to_string()),
    };
    if !res.status().is_success() {
        return error(
            StatusCode::BAD_GATEWAY,
            &format!("Speech failed (HTTP {}).", res.status().as_u16()),
        );
    }
    let mut stream = res.bytes_stream();
    let mut wav = Vec::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                if wav.len() + bytes.len() > 50 * 1024 * 1024 {
                    return error(StatusCode::BAD_GATEWAY, "Speech response is too large.");
                }
                wav.extend_from_slice(&bytes);
            }
            Err(e) => return error(StatusCode::BAD_GATEWAY, &e.to_string()),
        }
    }
    response(StatusCode::OK, "audio/wav", wav)
}
