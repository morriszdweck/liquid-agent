//! "For You": four ideas the agent could help with, written from what it knows about the user.
//! The everyday model writes them, in the language of the app and its replies.

use crate::{store, App};
use axum::{http::StatusCode, response::Response};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A line the model wrote as "Title | request". Long enough to be a real request, and free of markup.
fn parse(line: &str) -> Option<(String, String)> {
    let line = line.trim().replace("**", "");
    let line = line.trim().trim_start_matches(['-', '*', ' ']);
    let line = line.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ' ');
    // The model sometimes writes a markdown table row: "| Title | request |".
    let line = line.trim().trim_matches('|').trim();
    let (title, prompt) = line.split_once('|')?;
    let (title, prompt) = (title.trim(), prompt.trim());
    // Chinese and Japanese don't put spaces between words, so count characters for them.
    let long_enough = prompt.split_whitespace().count() >= 4 || prompt.chars().count() >= 12;
    // Both halves need words, not only dashes: a markdown table's "|---|---|" separator is not an idea.
    let has_words =
        title.chars().any(char::is_alphabetic) && prompt.chars().any(char::is_alphabetic);
    let clean = has_words && long_enough && !format!("{title}{prompt}").contains(['|', '`', '#']);
    clean.then(|| {
        (
            title.chars().take(60).collect(),
            prompt.chars().take(300).collect(),
        )
    })
}

/// A card is a request the user could type. Questions to the user, copies of what the agent knows
/// about them, and copies of the prompt's own label are rejected, so the next try can replace them.
fn usable(title: &str, prompt: &str, known: &[String], known_label: &str) -> bool {
    let question = [title, prompt]
        .iter()
        .any(|t| t.trim_end().ends_with(['?', '？']));
    let label = known_label
        .split("{facts}")
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches(':')
        .trim()
        .to_lowercase();
    let text = format!("{title} {prompt}").to_lowercase();
    let copies_label = label.chars().count() >= 8 && text.contains(&label);
    // A card copies a fact when the whole fact appears in it, or a long piece of the card is in the fact.
    let pieces: Vec<String> = [title, prompt]
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| t.chars().count() >= 12)
        .collect();
    let copies_fact = known
        .iter()
        .map(|fact| fact.trim().to_lowercase())
        .filter(|fact| fact.chars().count() >= 12)
        .any(|fact| {
            text.contains(&fact) || pieces.iter().any(|piece| fact.contains(piece.as_str()))
        });
    !question && !copies_label && !copies_fact
}

/// POST /api/ideas/refresh: writes new idea cards and saves them. Returns the ideas.
pub async fn refresh(app: &App) -> Response {
    let settings = app.settings.lock().unwrap().clone();
    let reply = liquid_core::i18n::reply_for(&settings);
    let strings = reply.strings;
    // Where the everyday model's cards read as the assistant talking, the app's own cards are shown instead.
    if !strings.ideas_model_ok {
        let items: Vec<Value> = strings
            .ideas_starter
            .iter()
            .map(|(title, prompt)| json!({"title": title, "prompt": prompt}))
            .collect();
        let ideas = json!({"at": now_ms(), "items": items});
        if let Err(e) = store::save(&app.data, "ideas.json", &ideas) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
        app.emit(json!({"type":"ideas","ideas":ideas}));
        return json_response(ideas);
    }
    if !app.backends.running("small") {
        return error(StatusCode::SERVICE_UNAVAILABLE, strings.ideas_need_brain);
    }
    let facts: Vec<String> = app.memory.lock().unwrap().clone();
    let mut items: Vec<Value> = Vec::new();
    if !facts.is_empty() {
        let known: Vec<String> = facts.iter().rev().take(15).rev().cloned().collect();
        let device = if cfg!(target_os = "macos") {
            "Mac"
        } else {
            strings.device_computer
        };
        // The language comes first: a long English instruction after it pulled the small model back into English.
        let system = format!(
            "{} {}",
            reply.directive(),
            strings.ideas_system.replace("{device}", device)
        );
        // The language is repeated last, where the small model is most likely to follow it.
        let user = format!(
            "{} {}",
            strings.ideas_known.replace("{facts}", &known.join("; ")),
            reply.directive()
        );
        let url = settings["smallURL"]
            .as_str()
            .unwrap_or("http://127.0.0.1:8180/v1");
        // A small model sometimes writes fewer than four usable lines; another try usually fixes it.
        for _ in 0..3 {
            let written = match complete(url, &system, &user, 260).await {
                Ok(text) => text,
                Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
            };
            let found: Vec<Value> = written
                .lines()
                .filter_map(parse)
                .filter(|(title, prompt)| usable(title, prompt, &known, strings.ideas_known))
                .take(4)
                .map(|(title, prompt)| json!({"title": title, "prompt": prompt}))
                .collect();
            if found.len() > items.len() {
                items = found;
            }
            if items.len() == 4 {
                break;
            }
        }
    }
    if items.is_empty() {
        // Nothing new came out, so the cards on screen stay as they are.
        return json_response(store::load_or(
            &app.data,
            "ideas.json",
            json!({"at":0,"items":[]}),
        ));
    }
    let ideas = json!({"at": now_ms(), "items": items});
    if let Err(e) = store::save(&app.data, "ideas.json", &ideas) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    app.emit(json!({"type":"ideas","ideas":ideas}));
    json_response(ideas)
}

/// One non-streaming reply from the everyday model. Its reasoning, if the template leaves any in the text, is dropped.
async fn complete(url: &str, system: &str, user: &str, max_tokens: u32) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let response: Value = client
        .post(format!("{}/chat/completions", url.trim_end_matches('/')))
        .json(&json!({
            "model": "LFM3-1.7B",
            "temperature": 0.6,
            "max_tokens": max_tokens,
            "stream": false,
            "chat_template_kwargs": {"enable_thinking": false},
            "messages": [{"role":"system","content":system},{"role":"user","content":user}],
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let content = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    let answer = match content.find("</think>") {
        Some(end) => &content[end + "</think>".len()..],
        None => content,
    };
    Ok(answer.trim().to_owned())
}

fn json_response(value: Value) -> Response {
    crate::json_response(StatusCode::OK, value)
}

fn error(status: StatusCode, message: &str) -> Response {
    crate::json_response(status, json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::{parse, usable};

    #[test]
    fn reads_title_and_request_lines_and_drops_the_rest() {
        assert_eq!(
            parse("1. Tidy Downloads | Sort the files in my Downloads folder by type"),
            Some((
                "Tidy Downloads".into(),
                "Sort the files in my Downloads folder by type".into()
            ))
        );
        assert_eq!(
            parse("| Suggest tips | Offer to find Brazilian cuisine ideas for dinner |"),
            Some((
                "Suggest tips".into(),
                "Offer to find Brazilian cuisine ideas for dinner".into()
            ))
        );
        assert!(!usable(
            "Cosa fai?",
            "Vuoi che ti aiuti con le ricette?",
            &[],
            ""
        ));
        assert!(!usable(
            "Titolo",
            "Lives in Lisbon and enjoys cooking",
            &["Lives in Lisbon and enjoys cooking Portuguese food.".into()],
            ""
        ));
        assert!(!usable(
            "Was ich über den Nutzer weiß",
            "Sortiere die Dateien",
            &[],
            "Was ich über den Nutzer weiß: {facts}"
        ));
        assert!(usable(
            "Tidy Downloads",
            "Sort the files in my Downloads folder by type",
            &["Lives in Lisbon".into()],
            "What I know: {facts}"
        ));
        assert!(parse("|----------|-------------|").is_none());
        assert!(parse("---------- | -------------").is_none());
        assert!(parse("Tidy | too short").is_none());
        assert!(parse("no separator here at all").is_none());
        assert_eq!(
            parse("整理下载 | 把我的下载文件夹里的文件按类型分到不同文件夹"),
            Some((
                "整理下载".into(),
                "把我的下载文件夹里的文件按类型分到不同文件夹".into()
            ))
        );
    }
}
