mod handover;
mod launcher;

use anyhow::{Context, Result};
use liquid_guardian::Guardian;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const MAX_BODY: u64 = 2 * 1024 * 1024;

fn main() -> Result<()> {
    if std::env::current_exe()?
        .file_name()
        .is_some_and(|name| name == "liquid-agent")
    {
        return launcher::run();
    }
    let mut args = std::env::args().skip(1);
    let folder = args
        .next()
        .context("usage: liquid-guardian MODEL_FOLDER [PORT] [MODEL_NAME]")?;
    if folder == "--handover" {
        return handover::run(args.collect());
    }
    if folder == "--hard-deny"
        || folder == "--parse-tool-call"
        || folder == "--search-memory"
        || folder == "--validate-settings"
        || folder == "--parse-hf-link"
        || folder == "--gguf-variants"
        || folder == "--clean-routine"
        || folder == "--due-routines"
    {
        let mut input = String::new();
        let max_body = if folder == "--gguf-variants" || folder == "--due-routines" {
            32 * 1024 * 1024
        } else {
            MAX_BODY
        };
        std::io::stdin()
            .take(max_body + 1)
            .read_to_string(&mut input)?;
        anyhow::ensure!(input.len() as u64 <= max_body, "request too large");
        let input: Value = serde_json::from_str(&input)?;
        if folder == "--clean-routine" {
            println!(
                "{}",
                liquid_core::routines::clean(
                    input.get("input").unwrap_or(&Value::Null),
                    input.get("base").unwrap_or(&Value::Null)
                )
            );
            return Ok(());
        }
        if folder == "--due-routines" {
            let time = input
                .get("time")
                .and_then(Value::as_str)
                .context("missing time")?;
            let day = input
                .get("day")
                .and_then(Value::as_i64)
                .context("missing day")?;
            let now = input
                .get("now")
                .and_then(Value::as_i64)
                .context("missing now")?;
            println!(
                "{}",
                json!(liquid_core::routines::due(
                    input.get("routines").unwrap_or(&Value::Null),
                    time,
                    day,
                    now
                ))
            );
            return Ok(());
        }
        if folder == "--parse-hf-link" || folder == "--gguf-variants" {
            let result = if folder == "--parse-hf-link" {
                liquid_core::models::parse_hf_link(
                    input.get("text").and_then(Value::as_str).unwrap_or(""),
                )
            } else {
                liquid_core::models::variants(
                    input.get("files").unwrap_or(&Value::Null),
                    input.get("memoryGB").and_then(Value::as_f64).unwrap_or(8.0),
                )
            };
            println!(
                "{}",
                match result {
                    Ok(value) => json!({"value":value}),
                    Err(message) => json!({"error":message}),
                }
            );
            return Ok(());
        }
        if folder == "--validate-settings" {
            let field = |name: &str| input.get(name).with_context(|| format!("missing {name}"));
            println!(
                "{}",
                liquid_core::settings::apply(
                    field("current")?,
                    field("defaults")?,
                    field("choices")?,
                    field("patch")?
                )
            );
            return Ok(());
        }
        if folder == "--search-memory" {
            let facts = input
                .get("facts")
                .and_then(Value::as_array)
                .context("missing facts")?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).context("invalid fact"))
                .collect::<Result<Vec<_>>>()?;
            let query = input
                .get("query")
                .and_then(Value::as_str)
                .context("missing query")?;
            let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(4) as usize;
            println!(
                "{}",
                json!(liquid_core::memory::search(&facts, query, limit))
            );
            return Ok(());
        }
        if folder == "--parse-tool-call" {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .context("missing text")?;
            let tools = input.get("tools").context("missing tools")?;
            println!("{}", liquid_core::toolparser::parse(text, tools));
            return Ok(());
        }
        let tool = input.get("tool").and_then(Value::as_str).unwrap_or("");
        let command = input.get("command").and_then(Value::as_str).unwrap_or("");
        println!("{}", json!({"deny": liquid_core::hard_deny(tool, command)}));
        return Ok(());
    }
    if folder == "--probe-gguf" {
        let file = args
            .next()
            .context("usage: liquid-guardian --probe-gguf FILE")?;
        let info = liquid_core::gguf::probe(file)?;
        println!(
            "{}",
            json!({"architecture":info.architecture, "contextLength":info.context_length,
            "hasTemplate":info.has_template, "thinking":info.thinking, "name":info.name})
        );
        return Ok(());
    }
    let port: u16 = args.next().unwrap_or_else(|| "8766".into()).parse()?;
    let model_name = args
        .next()
        .unwrap_or_else(|| "ProCreations/auto-150m-3".into());
    let guardian = Guardian::load(Path::new(&folder))?;
    guardian
        .classify(&json!({"tool":"Bash", "args":"ls", "request":"List my files.", "history":[]}))?;
    let server =
        Server::http(("127.0.0.1", port)).map_err(|e| anyhow::anyhow!("binding guardian: {e}"))?;
    eprintln!(
        "{}",
        liquid_core::i18n::diag_language()
            .guardian_ready
            .replace("{model}", &model_name)
            .replace("{port}", &port.to_string())
    );
    for mut request in server.incoming_requests() {
        let (status, body) = match (request.method(), request.url()) {
            (&Method::Get, "/health") => (200, json!({"ok":true, "model":model_name})),
            (&Method::Post, "/classify") => {
                let mut bytes = Vec::new();
                let result = request
                    .as_reader()
                    .take(MAX_BODY + 1)
                    .read_to_end(&mut bytes)
                    .map_err(anyhow::Error::from)
                    .and_then(|_| {
                        anyhow::ensure!(bytes.len() as u64 <= MAX_BODY, "request too large");
                        let body: Value = serde_json::from_slice(&bytes)?;
                        guardian.classify(&body)
                    });
                match result {
                    Ok(score) if score.is_finite() => (200, json!({"p_deny":score})),
                    Ok(_) => (500, json!({"error":"invalid model output"})),
                    Err(error) => (400, json!({"error":error.to_string()})),
                }
            }
            _ => (404, json!({"error":"not found"})),
        };
        let response = Response::from_string(body.to_string())
            .with_status_code(StatusCode(status))
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
        let _ = request.respond(response);
    }
    Ok(())
}
