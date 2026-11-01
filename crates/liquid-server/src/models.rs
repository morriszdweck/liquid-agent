//! Hugging Face model discovery for the Rust backend.
use crate::{installer, json_response};
use anyhow::{bail, Context, Result};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let mut request = client.get(url);
    if let Some(token) = std::env::var("HF_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("HUGGING_FACE_HUB_TOKEN")
                .ok()
                .filter(|s| !s.is_empty())
        })
    {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .context("Couldn't reach Hugging Face")?;
    match response.status().as_u16() {
        401|403 => bail!("This model is private or gated. Accept its terms on Hugging Face, or set HF_TOKEN and restart Liquid Agent."),
        404 => bail!("No model found at that link."),
        429 => bail!("Hugging Face is busy. Wait a minute, then try again."),
        _ => {}
    }
    let mut stream = response.error_for_status()?.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        anyhow::ensure!(
            bytes.len() + chunk.len() <= 16_000_000,
            "Hugging Face response is too large."
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes).context("Hugging Face sent invalid JSON")?)
}
pub async fn resolve(link: &str) -> Result<Value> {
    let parsed = liquid_core::models::parse_hf_link(link).map_err(anyhow::Error::msg)?;
    let repo = parsed["repo"].as_str().unwrap();
    let revision = parsed["revision"].as_str().unwrap();
    let mut base = url::Url::parse(&installer::hf_base())?;
    {
        let mut path = base
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid Hugging Face URL"))?;
        path.pop_if_empty().extend(["api", "models"]);
        for part in repo.split('/') {
            path.push(part);
        }
    }
    let mut tree = base.clone();
    {
        let mut path = tree.path_segments_mut().unwrap();
        path.extend(["tree", revision]);
    }
    tree.set_query(Some("recursive=true&expand=true"));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("liquid-agent/0.2")
        .build()?;
    let (info, files) = tokio::try_join!(
        get_json(&client, base.as_str()),
        get_json(&client, tree.as_str())
    )?;
    anyhow::ensure!(files.is_array(), "Hugging Face sent an invalid file list.");
    let result = liquid_core::models::variants(&files, crate::backends::memory_gb() as f64)
        .map_err(anyhow::Error::msg)?;
    let mut variants = result["variants"].as_array().unwrap().clone();
    let requested = parsed["file"]
        .as_str()
        .map(|file| {
            variants
                .iter()
                .find(|v| {
                    v["file"] == file
                        || v["shards"]
                            .as_array()
                            .is_some_and(|v| v.iter().any(|s| s == file))
                })
                .map(|v| v["id"].clone())
        })
        .transpose_option()
        .context("That file isn't a text GGUF model in this repository.")?;
    for variant in &mut variants {
        variant["size"] = json!(format!(
            "{:.1} GB",
            variant["bytes"].as_f64().unwrap_or(0.0) / 1e9
        ));
    }
    let card = &info["cardData"];
    let license = card
        .get("license_name")
        .or_else(|| card.get("license"))
        .cloned()
        .unwrap_or(Value::Null);
    let label = card["model_name"]
        .as_str()
        .or_else(|| info["modelId"].as_str().and_then(|s| s.rsplit('/').next()))
        .unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo));
    let license_url = card["license_link"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with("https://") || s.starts_with("http://") {
                s.to_owned()
            } else {
                format!(
                    "https://huggingface.co/{repo}/blob/{revision}/{}",
                    s.trim_start_matches('/')
                )
            }
        })
        .unwrap_or_else(|| format!("https://huggingface.co/{repo}"));
    Ok(
        json!({"repo":repo,"revision":revision,"label":label,"license":license,"licenseUrl":license_url,"gated":!info["gated"].is_null() && info["gated"]!=false,"variants":variants,"recommended":result["recommended"],"requested":requested,"warning":result["warnings"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")}),
    )
}
trait TransposeOption<T> {
    fn transpose_option(self) -> Option<Option<T>>;
}
impl<T> TransposeOption<T> for Option<Option<T>> {
    fn transpose_option(self) -> Option<Option<T>> {
        match self {
            Some(Some(v)) => Some(Some(v)),
            Some(None) => None,
            None => Some(None),
        }
    }
}
pub async fn handle(request: Request) -> Response {
    let body = match to_bytes(request.into_body(), 1_000_000).await {
        Ok(b) => b,
        Err(_) => {
            return json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error":"That request is too big."}),
            )
        }
    };
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return json_response(StatusCode::BAD_REQUEST, json!({"error":"Bad JSON."})),
    };
    match resolve(value["link"].as_str().unwrap_or("")).await {
        Ok(v) => json_response(StatusCode::OK, v),
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({"error":e.to_string()})),
    }
}

pub(crate) fn safe_variant(value: &Value) -> bool {
    let Some(id) = value["id"].as_str() else {
        return false;
    };
    if value["file"].as_str() != Some(id) {
        return false;
    }
    let Some(shards) = value["shards"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 1000)
    else {
        return false;
    };
    shards.iter().all(|v| {
        v.as_str().is_some_and(|s| {
            s.to_ascii_lowercase().ends_with(".gguf")
                && std::path::Path::new(s)
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_)))
        })
    }) && shards.iter().any(|v| v == id)
}
async fn read_body(request: Request) -> Result<Value> {
    let bytes = to_bytes(request.into_body(), 1_000_000).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn current_part(app: &crate::App) -> Value {
    let settings = app.settings.lock().unwrap().clone();
    app.backends
        .parts(&app.data, &settings)
        .into_iter()
        .find(|p| p["id"] == "small")
        .unwrap_or(Value::Null)
}
pub async fn change(app: &crate::App, request: Request, action: &str) -> Response {
    let input = if action == "clear" {
        json!({})
    } else {
        match read_body(request).await {
            Ok(v) => v,
            Err(_) => return json_response(StatusCode::BAD_REQUEST, json!({"error":"Bad JSON."})),
        }
    };
    let resolved = if action == "set" {
        match resolve(input["link"].as_str().unwrap_or("")).await {
            Ok(v) => Some(v),
            Err(e) => {
                return json_response(StatusCode::BAD_REQUEST, json!({"error":e.to_string()}))
            }
        }
    } else {
        None
    };
    {
        let mut state = app.backends.installs.lock().unwrap();
        if state.busy {
            return json_response(
                StatusCode::CONFLICT,
                json!({"error":"Wait for the current download to finish."}),
            );
        }
        state.busy = true;
    }
    let result: Result<bool>=async {
        let previous=crate::store::load_or(&app.data,"custom-model.json",Value::Null);
        if action=="clear" {
            if previous.is_null() {return Ok(false);}
            crate::backends::action(app,"small","stop").await;
            let file=app.data.join("custom-model.json");
            if file.exists() {tokio::fs::remove_file(file).await?;}
            let dir=app.data.join("models/custom"); if dir.exists() {tokio::fs::remove_dir_all(dir).await?;}
            let settings=app.settings.lock().unwrap().clone();
            app.backends.set(app,"small",json!({"status":if crate::backends::installed(&app.data,&settings,"small"){"installed"}else{"missing"}}));
            return Ok(false);
        }
        let source=resolved.as_ref().unwrap_or(&previous);
        let variants=source["variants"].as_array().context("Add a model from Hugging Face first.")?;
        anyhow::ensure!(variants.len()<=100 && variants.iter().all(safe_variant),"That model's files couldn't be used.");
        let file=input["file"].as_str().filter(|s|!s.is_empty()).or_else(||source["requested"].as_str()).or_else(||source["recommended"].as_str()).context("Pick a model size.")?;
        let variant=variants.iter().find(|v|v["id"]==file).context("Pick one of the sizes Hugging Face offered.")?;
        let mut next=source.clone();
        for field in ["file","quant","bytes","shards","shardBytes"] {next[field]=variant[field].clone();}
        next["meta"]=Value::Null;
        let different=previous["repo"]!=next["repo"] || previous["revision"]!=next["revision"];
        crate::backends::action(app,"small","stop").await;
        if different { let dir=app.data.join("models/custom"); if dir.exists() {tokio::fs::remove_dir_all(dir).await?;} }
        crate::store::save(&app.data,"custom-model.json",&next)?;
        app.backends.set(app,"small",json!({"status":"missing"}));
        Ok(true)
    }.await;
    {
        app.backends.installs.lock().unwrap().busy = false;
    }
    match result {
        Ok(download) => {
            if download {
                crate::installer::enqueue(app, &[json!("small")]);
            } else {
                crate::installer::enqueue(app, &[]);
                let settings = app.settings.lock().unwrap().clone();
                if crate::backends::installed(&app.data, &settings, "small")
                    && !app.backends.active("small")
                {
                    let _ = crate::backends::action(app, "small", "start").await;
                }
            }
            json_response(StatusCode::OK, current_part(app))
        }
        Err(e) => {
            crate::installer::enqueue(app, &[]);
            json_response(StatusCode::BAD_REQUEST, json!({"error":e.to_string()}))
        }
    }
}
