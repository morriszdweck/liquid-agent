//! Scheduled routines and reminders, persisted before notifications are emitted.
use crate::{chat, json_response, store, App};
use axum::{body::to_bytes, http::StatusCode, response::Response};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn local_minute() -> Option<(String, i64)> {
    let stamp: libc::time_t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs()
        .try_into()
        .ok()?;
    let mut output = std::mem::MaybeUninit::<libc::tm>::uninit();
    // localtime_r writes a complete tm for a valid timestamp and respects the local timezone.
    let result = unsafe { libc::localtime_r(&stamp, output.as_mut_ptr()) };
    if result.is_null() {
        return None;
    }
    let output = unsafe { output.assume_init() };
    Some((
        format!("{:02}:{:02}", output.tm_hour, output.tm_min),
        i64::from(output.tm_wday),
    ))
}
pub fn reminder(app: &App, text: &str, minutes: f64) -> anyhow::Result<String> {
    anyhow::ensure!(
        minutes.is_finite() && minutes > 0.0 && minutes <= 5_256_000.0,
        "Invalid reminder time."
    );
    let minutes = minutes.max(0.5);
    let at = now()
        .checked_add((minutes * 60_000.0) as u64)
        .ok_or_else(|| anyhow::anyhow!("Invalid reminder time"))?;
    let value =
        json!({"id":store::id(),"text":text.chars().take(1000).collect::<String>(),"at":at});
    let mut reminders = app.reminders.lock().unwrap();
    let mut next = reminders.clone();
    next.push(value);
    store::save(&app.data, "reminders.json", &json!(next))?;
    *reminders = next.clone();
    drop(reminders);
    app.emit(json!({"type":"reminders","reminders":next}));
    Ok(format!("Reminder set for {minutes} minutes from now."))
}
pub fn delete_reminder(app: &App, id: &str) -> Response {
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return json_response(StatusCode::NOT_FOUND, json!({"error":"Not found."}));
    }
    let mut reminders = app.reminders.lock().unwrap();
    let mut next = reminders.clone();
    next.retain(|r| r["id"] != id);
    if let Err(e) = store::save(&app.data, "reminders.json", &json!(next)) {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":e.to_string()}),
        );
    }
    *reminders = next.clone();
    drop(reminders);
    app.emit(json!({"type":"reminders","reminders":next}));
    json_response(StatusCode::OK, json!({"ok":true}))
}
fn fire_reminders(app: &App) {
    let mut reminders = app.reminders.lock().unwrap();
    let stamp = now();
    let due: Vec<_> = reminders
        .iter()
        .filter(|r| r["at"].as_u64().is_some_and(|at| at <= stamp))
        .cloned()
        .collect();
    if due.is_empty() {
        return;
    }
    let next: Vec<_> = reminders
        .iter()
        .filter(|r| !r["at"].as_u64().is_some_and(|at| at <= stamp))
        .cloned()
        .collect();
    if let Err(e) = store::save(&app.data, "reminders.json", &json!(next)) {
        eprintln!(
            "{}",
            liquid_core::i18n::diag_language()
                .save_reminders
                .replace("{error}", &e.to_string())
        );
        return;
    }
    *reminders = next.clone();
    drop(reminders);
    app.emit(json!({"type":"reminders","reminders":next}));
    for reminder in due {
        let text = reminder["text"].as_str().unwrap_or("Reminder");
        app.emit(json!({"type":"notify","title":"Reminder","body":text}));
        desktop_notify(text);
    }
}
pub(crate) fn desktop_notify(text: &str) {
    let text = text.to_owned();
    tokio::spawn(async move {
        let mut command = if cfg!(target_os = "macos") {
            let mut command = tokio::process::Command::new("osascript");
            command.args([
                "-e",
                "on run argv",
                "-e",
                "display notification (item 1 of argv) with title \"Reminder\"",
                "-e",
                "end run",
                "--",
                &text,
            ]);
            command
        } else {
            let mut command = tokio::process::Command::new("notify-send");
            command.args(["--", "Reminder", &text]);
            command
        };
        let _ = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status()
            .await;
    });
}
pub async fn run(app: &App, id: &str, scheduled: bool) -> Response {
    let _guard = app.routine_runs.lock().await;
    let routine = {
        let routines = app.routines.lock().unwrap();
        routines.iter().find(|r| r["id"] == id).cloned()
    };
    let Some(routine) = routine else {
        return json_response(StatusCode::NOT_FOUND, json!({"error":"Not found."}));
    };
    if scheduled {
        let Some((time, day)) = local_minute() else {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error":"Could not read local time."}),
            );
        };
        if liquid_core::routines::due(&json!([routine]), &time, day, now() as i64).is_empty() {
            return json_response(
                StatusCode::CONFLICT,
                json!({"error":"Routine is no longer due."}),
            );
        }
    }
    let prompt = routine["prompt"].as_str().unwrap_or("");
    let response = chat::send(app, None, &json!({"text":prompt}));
    if !response.status().is_success() {
        return response;
    }
    let bytes = match to_bytes(response.into_body(), 1_000_000).await {
        Ok(b) => b,
        Err(_) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error":"Could not read routine chat."}),
            )
        }
    };
    let Ok(mut created) = serde_json::from_slice::<Value>(&bytes) else {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"Could not read routine chat."}),
        );
    };
    let Some(chat_id) = created["id"].as_str().map(str::to_owned) else {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"error":"Invalid routine chat."}),
        );
    };
    let title = routine["name"].as_str().unwrap_or("Routine");
    {
        let mut chats = app.chats.lock().unwrap();
        let mut next = chats.clone();
        if let Some(c) = next.iter_mut().find(|c| c["id"] == chat_id) {
            c["title"] = json!(title);
            c["source"] = json!("routine");
            c["named"] = json!(true);
            created = c.clone();
            if store::save_array(&app.data, "chats.json", &next).is_ok() {
                *chats = next;
            }
        }
    }
    app.emit(json!({"type":"chat","chat":created}));
    {
        let mut routines = app.routines.lock().unwrap();
        let mut next = routines.clone();
        if let Some(r) = next.iter_mut().find(|r| r["id"] == id) {
            r["lastRun"] = json!(now());
            r["lastChatId"] = json!(chat_id);
            if let Err(e) = store::save(&app.data, "routines.v2.json", &json!(next)) {
                eprintln!(
                    "{}",
                    liquid_core::i18n::diag_language()
                        .save_routine
                        .replace("{error}", &e.to_string())
                );
            } else {
                *routines = next.clone();
                app.emit(json!({"type":"routines","routines":next}));
            }
        }
    }
    if scheduled {
        app.emit(json!({"type":"notify","title":format!("Running “{title}”"),"body":"Your scheduled routine started.","chatId":chat_id,"kind":"routine"}));
    }
    json_response(StatusCode::OK, created)
}
pub async fn worker(app: App) {
    let interval = std::env::var("LIQUID_AGENT_SCHEDULE_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(15_000)
        .clamp(100, 30_000);
    let mut timer = tokio::time::interval(Duration::from_millis(interval));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        timer.tick().await;
        fire_reminders(&app);
        if let Some((time, day)) = local_minute() {
            let due = {
                let routines = app.routines.lock().unwrap();
                liquid_core::routines::due(&json!(*routines), &time, day, now() as i64)
            };
            for id in due {
                let _ = run(&app, &id, true).await;
            }
        }
    }
}
