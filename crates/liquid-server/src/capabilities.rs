//! Explicit, limited checks against the running multimodal engine.
use crate::{json_response, media, App};
use axum::{http::StatusCode, response::Response};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

async fn realtime(url: &url::Url) -> anyhow::Result<()> {
    let mut ws = url.clone();
    let scheme = match ws.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => anyhow::bail!("Invalid engine scheme"),
    };
    ws.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("Invalid engine scheme"))?;
    ws.set_path(&format!("{}/realtime", ws.path().trim_end_matches('/')));
    ws.set_query(None);
    ws.set_fragment(None);
    let (mut socket, _) = tokio_tungstenite::connect_async(ws.as_str()).await?;
    let message = socket
        .next()
        .await
        .ok_or_else(|| anyhow::anyhow!("Realtime connection closed"))??;
    let Message::Text(raw) = message else {
        anyhow::bail!("No realtime session event")
    };
    let event: Value = serde_json::from_str(&raw)?;
    anyhow::ensure!(
        event["type"] == "session.created",
        "No realtime session event"
    );
    let _ = socket.close(None).await;
    Ok(())
}

pub(crate) async fn probe(app: &App) -> Response {
    if app.omni_slots_busy() {
        return json_response(
            StatusCode::CONFLICT,
            json!({"error":"Omni is busy with a voice call. End the call or configure another Omni slot."}),
        );
    }
    if !app.backends.running("omni") {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"Eyes and ears must be running for this check."}),
        );
    }
    let Some(_model_use) = app.backends.begin_model_use() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"The model is changing. Try again shortly."}),
        );
    };
    if !app.backends.running("omni") {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":"Eyes and ears is not running."}),
        );
    }
    let settings = app.settings.lock().unwrap().clone();
    let Some(url) = media::local_url(&settings) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error":"Refusing a model address that isn't on this computer."}),
        );
    };
    let realtime_ok = matches!(
        tokio::time::timeout(Duration::from_secs(10), realtime(&url)).await,
        Ok(Ok(()))
    );
    // This intentionally generates a short clip. It verifies a response, not pronunciation or voice identity.
    let speech = tokio::time::timeout(
        Duration::from_secs(120),
        media::synthesize(&url, "Hola.", "female", "es"),
    )
    .await;
    let speech_ok = match speech {
        Ok(Ok(wav)) => media::wav_format(&wav).is_some_and(|format| {
            format.encoding == 1
                && format.channels == 1
                && format.bits == 16
                && format.rate > 0
                && !format.data.is_empty()
                && format.data.len() % 2 == 0
        }),
        _ => false,
    };
    json_response(
        StatusCode::OK,
        json!({"spanishWav":speech_ok,"realtimeHandshake":realtime_ok}),
    )
}
