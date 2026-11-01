//! Local safety classifier protocol. Failure always falls back to user approval.
use crate::App;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

fn adapt(tool: &str, args: &Value) -> Value {
    let text = |key: &str, fallback: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_owned()
    };
    match tool {
        "shell" => json!({"tool":"Bash","args":text("command","")}),
        "read_file" => json!({"tool":"Read","args":text("path","")}),
        "write_file" => {
            json!({"tool":"Write","args":json!({"file_path":args.get("path"),"content":text("content","").chars().take(4000).collect::<String>()}).to_string()})
        }
        "list_dir" => json!({"tool":"LS","args":text("path",".")}),
        "open" => {
            json!({"tool":"Bash","args":format!("{} {}",if cfg!(target_os="macos"){"open"}else{"xdg-open"},json!(text("target", "")))})
        }
        "web_search" => json!({"tool":"WebSearch","args":text("query","")}),
        "fetch_url" => json!({"tool":"WebFetch","args":text("url","")}),
        _ => json!({"tool":tool,"args":args.to_string()}),
    }
}
pub async fn classify(
    app: &App,
    tool: &str,
    args: &Value,
    request: &str,
    steps: &[Value],
    settings: &Value,
    cancel: &CancellationToken,
) -> Option<f64> {
    if !app.backends.running("guardian") {
        return None;
    }
    let url = settings.get("guardianURL")?.as_str()?;
    let parsed = url::Url::parse(url).ok()?;
    if !liquid_core::settings::is_local(url) || !["http", "https"].contains(&parsed.scheme()) {
        return None;
    }
    let mut body = adapt(tool, args);
    body["request"] = json!(request);
    body["history"] = json!(steps
        .iter()
        .filter(|step| step["status"] != "denied")
        .map(|step| {
            let mut item = adapt(step["tool"].as_str().unwrap_or(""), &step["args"]);
            item["result"] = json!(step["result"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(400)
                .collect::<String>());
            item
        })
        .collect::<Vec<_>>());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;
    let request = client
        .post(format!("{}/classify", url.trim_end_matches('/')))
        .json(&body)
        .send();
    let res = tokio::select! { _=cancel.cancelled()=>return None, result=request=>result.ok()? };
    if !res.status().is_success() {
        return None;
    }
    let mut stream = res.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        let chunk =
            tokio::select! { _=cancel.cancelled()=>return None, chunk=stream.next()=>chunk };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.ok()?;
        if bytes.len() + chunk.len() > 65_536 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let score = value.get("p_deny")?.as_f64()?;
    (score.is_finite() && (0.0..=1.0).contains(&score)).then_some(score)
}
