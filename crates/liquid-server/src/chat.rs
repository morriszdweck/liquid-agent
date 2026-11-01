//! Streaming text chat against a locally managed llama.cpp server.
use crate::{json_response, store, uploads, App};
use axum::{http::StatusCode, response::Response};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}
fn wire(
    chat: &Value,
    settings: &Value,
    facts: &[String],
    index: &serde_json::Map<String, Value>,
    data: &Path,
    omni: bool,
    offer_tools: bool,
    browser: bool,
    vision: bool,
) -> Vec<Value> {
    let messages = chat
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let query = messages
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .and_then(|m| m["content"].as_str())
        .unwrap_or("");
    let relevant = liquid_core::memory::search(facts, query, 4);
    // The language the reply is written in, and the words the prompts use for it.
    let reply = liquid_core::i18n::reply_for(settings);
    let s = reply.strings;
    let personality = reply.personality(settings["personality"].as_str().unwrap_or(""));
    let mut system = [
        s.persona.to_owned(),
        reply.directive(),
        personality.to_owned(),
        s.markdown.to_owned(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    if offer_tools {
        system.push('\n');
        system.push_str(&crate::tools::prompt(s));
        if browser {
            system.push_str(&crate::tools::browser_prompt(s));
        }
        if vision {
            system.push_str(&crate::tools::vision_prompt(s));
        }
    } else {
        system.push_str(s.direct);
    }
    if omni {
        system.push_str(s.attachments);
    }
    if let Some(name) = settings["userName"].as_str().filter(|n| !n.is_empty()) {
        system.push_str(&s.user_name.replace("{name}", name));
    }
    if !relevant.is_empty() {
        system.push('\n');
        system.push_str(&s.user_facts.replace("{facts}", &relevant.join("; ")));
    }
    let budget = settings["contextBudget"]
        .as_u64()
        .unwrap_or(6000)
        .clamp(256, 16000) as usize
        * 4;
    let mut used = system.len();
    let mut selected = Vec::new();
    let mut saw_user = false;
    let mut image_used = false;
    let mut audio_used = false;
    for message in messages.iter().rev() {
        let role = message["role"].as_str().unwrap_or("");
        if !["user", "assistant"].contains(&role) {
            continue;
        }
        let mut text = message["content"].as_str().unwrap_or("").to_owned();
        let mut parts = Vec::new();
        let mut media_cost = 0;
        if role == "user" {
            for attachment in message
                .get("attachments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = attachment["id"].as_str().unwrap_or("");
                let name = attachment["name"].as_str().unwrap_or("file");
                let kind = attachment["kind"].as_str().unwrap_or("other");
                let record = index.get(id);
                if kind == "text" {
                    let limit = if !saw_user { 8000 } else { 600 };
                    let content = record
                        .and_then(|r| uploads::text_for(data, r, limit))
                        .unwrap_or_default();
                    let clipped: String = content.chars().take(limit).collect();
                    let suffix = if content.chars().count() > limit {
                        "\n…(cut)"
                    } else {
                        ""
                    };
                    text.push_str(&format!("\n\n[File: {name}]\n{clipped}{suffix}"));
                } else if omni
                    && ((kind == "image" && !image_used) || (kind == "audio" && !audio_used))
                {
                    let bytes = record
                        .and_then(|r| uploads::path_for(data, r))
                        .and_then(|p| {
                            let meta = std::fs::metadata(&p).ok()?;
                            if meta.len() > 25 * 1024 * 1024 {
                                return None;
                            }
                            std::fs::read(p).ok()
                        });
                    if let Some(bytes) = bytes {
                        let encoded = BASE64.encode(&bytes);
                        if kind == "image" {
                            image_used = true;
                            media_cost += 4000;
                            parts.push(json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{encoded}",attachment["mime"].as_str().unwrap_or("application/octet-stream"))}}));
                        } else {
                            audio_used = true;
                            media_cost += ((bytes.len() + 31999) / 32000) * 100 + 80;
                            parts.push(json!({"type":"input_audio","input_audio":{"data":encoded,"format":"wav"}}));
                        }
                    } else {
                        text.push_str(&format!("\n[{kind}: {name}, no longer available]"));
                    }
                } else {
                    text.push_str(&format!(
                        "\n[{}: {name}]",
                        if kind == "other" { "file" } else { kind }
                    ));
                }
            }
        }
        if text.is_empty() && parts.is_empty() {
            continue;
        }
        let cost = text.len() + media_cost;
        if saw_user && used + cost > budget {
            break;
        }
        used += cost;
        let content = if parts.is_empty() {
            json!(text)
        } else {
            if !text.trim().is_empty() {
                parts.push(json!({"type":"text","text":text.trim()}));
            }
            json!(parts)
        };
        selected.push(json!({"role":role,"content":content}));
        if role == "user" {
            saw_user = true;
        }
    }
    selected.reverse();
    let mut merged: Vec<Value> = Vec::new();
    for item in selected {
        if let Some(previous) = merged
            .last_mut()
            .filter(|previous| previous["role"] == item["role"])
        {
            if let (Some(left), Some(right)) =
                (previous["content"].as_str(), item["content"].as_str())
            {
                previous["content"] = json!(format!("{left}\n\n{right}"));
            } else {
                let to_parts = |value: &Value| -> Vec<Value> {
                    if let Some(parts) = value.as_array() {
                        parts.clone()
                    } else if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
                        vec![json!({"type":"text","text":text})]
                    } else {
                        Vec::new()
                    }
                };
                let mut parts = to_parts(&previous["content"]);
                parts.extend(to_parts(&item["content"]));
                previous["content"] = json!(parts);
            }
        } else {
            merged.push(item);
        }
    }
    let mut result = vec![json!({"role":"system","content":system})];
    result.extend(merged);
    result
}

fn wants_tools(request: &str, chat: &Value) -> bool {
    use std::sync::OnceLock;
    static WORDS: OnceLock<regex::Regex> = OnceLock::new();
    let expression = WORDS.get_or_init(|| regex::Regex::new(r"(?i)\b(files?|folders?|desktop|downloads|documents|disk|directory|open|launch|run|command|terminal|shell|install|apps?|mac|linux|computer|search|google|look\s?up|fetch|pages?|web|websites?|site|online|internet|url|links?|browse|browser|click|news|weather|forecast|price|stocks?|score|latest|current|today|tonight|tomorrow|yesterday|now|recent|remind|reminder|remember|forget|recall|clipboard|copy|paste|screen|screenshot|pictures?|images?|photos?|audio|transcribe|listen|see|save|read|list|delete|move|rename|battery|my)\b|[~/]\w|\.[a-z]{2,4}\b").unwrap());
    expression.is_match(request)
        || chat
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .rev()
            .find(|m| m["role"] == "assistant" && m["status"] != "streaming")
            .and_then(|m| m.get("steps"))
            .and_then(Value::as_array)
            .is_some_and(|steps| !steps.is_empty())
}

// Keep partial tool calls out of streamed prose. Actions are not yet supported.
/// Some templates leave the model's thinking in the text, closed by </think>, instead of reporting
/// it separately. Returns (the answer, the thinking).
fn split_thinking(text: &str) -> (&str, &str) {
    if let Some(end) = text.find("</think>") {
        let before = &text[..end];
        let thinking = before
            .trim_start()
            .strip_prefix("<think>")
            .unwrap_or(before)
            .trim();
        return (text[end + "</think>".len()..].trim_start(), thinking);
    }
    match text.trim_start().strip_prefix("<think>") {
        Some(rest) => ("", rest.trim()),
        None => (text, ""),
    }
}

fn visible_text(text: &str) -> (&str, bool) {
    let mut cut = text.len();
    let mut found = false;
    for marker in ["<tool_call>", "<|tool_call_start|>", "<function="] {
        if let Some(index) = text.find(marker) {
            cut = cut.min(index);
            found = true;
        }
        for n in (1..marker.len()).rev() {
            if text.ends_with(&marker[..n]) {
                cut = cut.min(text.len() - n);
                break;
            }
        }
    }
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix('[') {
            let length = rest
                .bytes()
                .take_while(|c| c.is_ascii_lowercase() || *c == b'_')
                .count();
            if length > 0 && rest.as_bytes().get(length) == Some(&b'(') {
                cut = cut.min(offset);
                found = true;
            }
        }
        offset += line.len();
    }
    (&text[..cut], found)
}

pub fn send(app: &App, target: Option<&str>, input: &Value) -> Response {
    submit(app, target, input, "send")
}
pub fn revise(app: &App, id: &str, input: &Value, action: &str) -> Response {
    submit(app, Some(id), input, action)
}
fn submit(app: &App, target: Option<&str>, input: &Value, action: &str) -> Response {
    let mut text = input
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if input
        .get("attachments")
        .is_some_and(|files| !files.is_null() && !files.is_array())
    {
        return error(StatusCode::BAD_REQUEST, "Attachments must be a list.");
    }
    let upload_index = app.uploads.lock().unwrap().clone();
    let mut files: Vec<Value> = input
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|id| upload_index.get(id))
        .map(uploads::public)
        .collect();
    if action == "send" && text.is_empty() && files.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Type a message first.");
    }
    let settings = app.settings.lock().unwrap().clone();
    let mut running = app.running.lock().unwrap();
    if target.is_some_and(|id| running.contains_key(id)) {
        return error(
            StatusCode::CONFLICT,
            "I'm still working on the last message.",
        );
    }
    let mut chats = app.chats.lock().unwrap();
    let mut next = chats.clone();
    let index = if let Some(id) = target {
        match next.iter().position(|c| c["id"] == id) {
            Some(i) => i,
            None => return error(StatusCode::NOT_FOUND, "Not found."),
        }
    } else {
        let stamp = now();
        next.insert(0,json!({"id":store::id(),"title":"New chat","createdAt":stamp,"updatedAt":stamp,"pinned":false,"messages":[]}));
        0
    };
    let chat = &mut next[index];
    let Some(messages) = chat.get_mut("messages").and_then(Value::as_array_mut) else {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "This chat has an invalid message list.",
        );
    };
    let first = messages.is_empty();
    match action {
        "send" => messages.push(
            json!({"id":store::id(),"role":"user","content":text,"attachments":files,"at":now()}),
        ),
        "edit" => {
            let id = input["messageId"].as_str().unwrap_or("");
            let Some(index) = messages
                .iter()
                .position(|m| m["id"] == id && m["role"] == "user")
            else {
                return error(StatusCode::NOT_FOUND, "Message not found.");
            };
            if text.is_empty() {
                return error(StatusCode::BAD_REQUEST, "Type a message first.");
            }
            let mut message = messages[index].clone();
            files = message["attachments"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            message["id"] = json!(store::id());
            message["content"] = json!(text);
            message["at"] = json!(now());
            messages.truncate(index);
            messages.push(message);
        }
        "regenerate" => {
            while messages.last().is_some_and(|m| m["role"] == "assistant") {
                messages.pop();
            }
            let Some(message) = messages.last().filter(|m| m["role"] == "user") else {
                return error(StatusCode::BAD_REQUEST, "No user message to regenerate.");
            };
            text = message["content"].as_str().unwrap_or("").to_owned();
            files = message["attachments"]
                .as_array()
                .cloned()
                .unwrap_or_default();
        }
        _ => return error(StatusCode::NOT_FOUND, "Not found."),
    }
    let media = messages
        .iter()
        .rev()
        .filter(|m| m["role"] == "user")
        .take(2)
        .any(|m| {
            m.get("attachments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|file| matches!(file["kind"].as_str(), Some("image" | "audio")))
        });
    let model = if media {
        if !app.backends.running("omni") {
            return error(StatusCode::SERVICE_UNAVAILABLE, "Pictures and audio need the Eyes and ears part. Turn it on in Settings → Downloads.");
        }
        "omni"
    } else if app.backends.running("small") {
        "small"
    } else if app.backends.running("omni") {
        "omni"
    } else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "No model is running yet. Open Settings → Downloads to set one up.",
        );
    };
    let url = settings[if model == "small" {
        "smallURL"
    } else {
        "omniURL"
    }]
    .as_str()
    .unwrap_or("");
    if !liquid_core::settings::is_local(url)
        || !matches!(
            url::Url::parse(url)
                .ok()
                .map(|u| u.scheme().to_owned())
                .as_deref(),
            Some("http" | "https")
        )
    {
        return error(
            StatusCode::BAD_REQUEST,
            "Refusing a model address that isn't on this computer.",
        );
    }
    let reply_id = store::id();
    messages.push(json!({"id":reply_id,"role":"assistant","content":"","steps":[],"status":"streaming","at":now(),"model":model}));
    if first && chat.get("named").and_then(Value::as_bool) != Some(true) {
        let title = text
            .split_whitespace()
            .take(7)
            .collect::<Vec<_>>()
            .join(" ");
        let title = if title.is_empty() {
            files
                .first()
                .and_then(|f| f["name"].as_str())
                .unwrap_or("New chat")
                .to_owned()
        } else {
            title
        };
        chat["title"] = json!(title.chars().take(60).collect::<String>());
    }
    chat["updatedAt"] = json!(now());
    let chat = chat.clone();
    let chat_id = chat["id"].as_str().unwrap().to_owned();
    if let Err(e) = store::save(&app.data, "chats.json", &json!(next)) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    *chats = next;
    let cancel = CancellationToken::new();
    running.insert(chat_id.clone(), cancel.clone());
    let active: Vec<String> = running.keys().cloned().collect();
    drop(chats);
    drop(running);
    app.emit(json!({"type":"running","running":active}));
    app.emit(json!({"type":"chat","chat":chat}));
    let app = app.clone();
    let facts = app.memory.lock().unwrap().clone();
    let offer_tools = wants_tools(&text, &chat);
    let request_text = text.to_owned();
    let browser = app.backends.running("browser");
    let vision = app.backends.running("omni");
    let messages = wire(
        &chat,
        &settings,
        &facts,
        &upload_index,
        &app.data,
        model == "omni",
        offer_tools,
        browser,
        vision,
    );
    tokio::spawn(async move {
        respond(
            app,
            chat_id,
            reply_id,
            settings,
            messages,
            cancel,
            model,
            offer_tools,
            browser,
            vision,
            request_text,
        )
        .await;
    });
    json_response(StatusCode::OK, chat)
}

pub fn stop(app: &App, id: &str) -> Response {
    if let Some(token) = app.running.lock().unwrap().get(id) {
        token.cancel();
    }
    json_response(StatusCode::OK, json!({"ok":true}))
}

async fn respond(
    app: App,
    chat_id: String,
    reply_id: String,
    settings: Value,
    mut messages: Vec<Value>,
    cancel: CancellationToken,
    model: &'static str,
    offer_tools: bool,
    browser: bool,
    vision: bool,
    request_text: String,
) {
    let started = std::time::Instant::now();
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tokens = 0u64;
    let output: anyhow::Result<()> = async {
        let max_steps = settings["maxSteps"].as_u64().unwrap_or(8).min(20) as usize;
        let descriptors = if offer_tools { crate::tools::descriptors(browser, vision) } else { json!({}) };
        let mut previous: Vec<Value> = Vec::new();
        for step_index in 0..=max_steps {
            content.clear();
            stream(&app, &chat_id, &reply_id, &settings, messages.clone(), &cancel, &mut content, &mut reasoning, &mut tokens, model).await?;
            let (answer, _) = split_thinking(&content);
            let parsed = liquid_core::toolparser::parse(answer, &descriptors);
            let note = parsed["text"].as_str().unwrap_or("").to_owned();
            if parsed["call"].is_null() {
                let strings = liquid_core::i18n::reply_for(&settings).strings;
                if visible_text(&content).1 { anyhow::bail!("{}", strings.tools_unavailable); }
                content = if note.is_empty() { strings.no_reply.into() } else { note };
                return Ok(());
            }
            if step_index == max_steps {
                let strings = liquid_core::i18n::reply_for(&settings).strings;
                content = format!("{}{}", if note.is_empty() { String::new() } else { format!("{note}\n\n") }, strings.step_limit.replace("{n}", &max_steps.to_string()));
                return Ok(());
            }
            let call = parsed["call"].clone();
            let repeats = previous.iter().filter(|old| *old == &call).count();
            if repeats >= 2 { content = "I kept trying the same thing, so I stopped. Could you tell me more about what you want?".into(); return Ok(()); }
            previous.push(call.clone());
            let raw = content.clone();
            let result = crate::agent_tools::run(&app, &chat_id, &reply_id, &call, &note, &request_text, model, &cancel).await?;
            messages.push(json!({"role":"assistant","content":raw}));
            messages.push(json!({"role":"user","content":format!("[result]\n{result}")}));
        }
        Ok(())
    }.await;
    content = visible_text(&content).0.to_owned();
    let status = if cancel.is_cancelled() {
        "stopped"
    } else if output.is_err() {
        "error"
    } else {
        "done"
    };
    let mut running = app.running.lock().unwrap();
    let mut chats = app.chats.lock().unwrap();
    running.remove(&chat_id);
    let active: Vec<String> = running.keys().cloned().collect();
    let mut event = None;
    if let Some(chat) = chats.iter_mut().find(|c| c["id"] == chat_id) {
        if let Some(reply) = chat
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .and_then(|m| m.iter_mut().find(|m| m["id"] == reply_id))
        {
            reply["status"] = json!(status);
            let (answer, leaked) = split_thinking(&content);
            reply["content"] = json!(answer.trim());
            let thinking = if reasoning.trim().is_empty() {
                leaked
            } else {
                reasoning.trim()
            };
            if !thinking.is_empty() {
                reply["thinking"] = json!(thinking);
            }
            if let Err(ref message) = output {
                if status == "error" {
                    reply["error"] = json!(message.to_string());
                }
            }
            if status != "done" {
                if let Some(steps) = reply.get_mut("steps").and_then(Value::as_array_mut) {
                    for step in steps {
                        if matches!(
                            step.get("status").and_then(Value::as_str),
                            Some("pending" | "checking" | "approval" | "running")
                        ) {
                            step["status"] = json!("denied");
                            step["result"] = json!("Stopped.");
                        }
                    }
                }
            }
            reply["stats"] =
                json!({"ms":started.elapsed().as_millis() as u64,"tokens":tokens,"tps":0});
        }
        chat["updatedAt"] = json!(now());
        event = Some(chat.clone());
    }
    if let Err(e) = store::save(&app.data, "chats.json", &json!(*chats)) {
        eprintln!(
            "{}",
            liquid_core::i18n::diag_language()
                .save_chat
                .replace("{error}", &e.to_string())
        );
    }
    drop(chats);
    drop(running);
    app.emit(json!({"type":"running","running":active}));
    if let Some(chat) = event {
        app.emit(json!({"type":"chat","chat":chat}));
    }
}

async fn stream(
    app: &App,
    chat_id: &str,
    reply_id: &str,
    settings: &Value,
    messages: Vec<Value>,
    cancel: &CancellationToken,
    content: &mut String,
    reasoning: &mut String,
    tokens: &mut u64,
    model: &str,
) -> anyhow::Result<()> {
    let url = settings[if model == "small" {
        "smallURL"
    } else {
        "omniURL"
    }]
    .as_str()
    .unwrap_or("");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()?;
    let request=client.post(format!("{}/chat/completions",url.trim_end_matches('/'))).json(&json!({"model":if model == "small" { "LFM3-1.7B" } else { "LFM3-Omni-2B" },"messages":messages,"temperature":if model == "small" { settings["temperature"].clone() } else { json!(0) },"max_tokens":1536,"stop":["<|tool_call_end|>","</tool_call>"],"stream":true,"stream_options":{"include_usage":true},"cache_prompt":true,"chat_template_kwargs":{"enable_thinking":false}})).send();
    let res =
        tokio::select! { _=cancel.cancelled()=>anyhow::bail!("Stopped."), result=request=>result? };
    if !res.status().is_success() {
        anyhow::bail!(
            "The model returned an error (HTTP {}).",
            res.status().as_u16()
        );
    }
    let mut stream = res.bytes_stream();
    let mut buffer = Vec::new();
    loop {
        let chunk = tokio::select! { _=cancel.cancelled()=>anyhow::bail!("Stopped."), chunk=stream.next()=>chunk };
        let Some(chunk) = chunk else { break };
        buffer.extend_from_slice(&chunk?);
        if buffer.len() > 4 * 1024 * 1024 {
            anyhow::bail!("The model response is too large.");
        }
        while let Some(end) = buffer.iter().position(|c| *c == b'\n') {
            let line = String::from_utf8_lossy(&buffer[..end]).trim().to_owned();
            buffer.drain(..=end);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(value) = event
                .pointer("/choices/0/delta/reasoning_content")
                .and_then(Value::as_str)
            {
                reasoning.push_str(value);
            }
            if let Some(value) = event
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
            {
                content.push_str(value);
            }
            if content.len() + reasoning.len() > 4 * 1024 * 1024 {
                anyhow::bail!("The model response is too large.");
            }
            if let Some(value) = event
                .pointer("/usage/completion_tokens")
                .and_then(Value::as_u64)
            {
                *tokens = value;
            }
            let (answer, leaked) = split_thinking(content);
            let (visible, _) = visible_text(answer);
            let thinking = if reasoning.is_empty() {
                leaked
            } else {
                reasoning.as_str()
            };
            app.emit(json!({"type":"delta","chatId":chat_id,"messageId":reply_id,"text":visible,"thinking":thinking}));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::split_thinking;

    #[test]
    fn splits_thinking_that_a_template_left_in_the_text() {
        assert_eq!(
            split_thinking("A plan</think>The answer"),
            ("The answer", "A plan")
        );
        assert_eq!(
            split_thinking("<think>A plan</think>\nThe answer"),
            ("The answer", "A plan")
        );
        assert_eq!(
            split_thinking("<think>still thinking"),
            ("", "still thinking")
        );
        assert_eq!(split_thinking("Just an answer"), ("Just an answer", ""));
    }
}
