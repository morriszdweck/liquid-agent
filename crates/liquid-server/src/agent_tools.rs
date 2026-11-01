//! Tool step lifecycle, authorization, and activity recording.
use crate::{store, tools, App};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn edit_step(
    app: &App,
    chat_id: &str,
    reply_id: &str,
    step_id: &str,
    patch: Value,
    new_step: bool,
) -> Result<()> {
    let mut chats = app.chats.lock().unwrap();
    let mut next = chats.clone();
    let chat = next
        .iter_mut()
        .find(|c| c["id"] == chat_id)
        .context("Chat no longer exists")?;
    let reply = chat
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .and_then(|v| v.iter_mut().find(|m| m["id"] == reply_id))
        .context("Reply no longer exists")?;
    let steps = reply
        .get_mut("steps")
        .and_then(Value::as_array_mut)
        .context("Invalid reply steps")?;
    if new_step {
        steps.push(patch);
    } else {
        let step = steps
            .iter_mut()
            .find(|s| s["id"] == step_id)
            .context("Step no longer exists")?;
        step.as_object_mut()
            .context("Invalid step")?
            .extend(patch.as_object().context("Invalid step update")?.clone());
    }
    chat["updatedAt"] = json!(now());
    let event = chat.clone();
    store::save(&app.data, "chats.json", &json!(next))?;
    *chats = next;
    drop(chats);
    app.emit(json!({"type":"chat","chat":event}));
    Ok(())
}
fn record(app: &App, chat_id: &str, step: &Value, ok: Option<bool>) -> Result<()> {
    let mut entry = json!({"id":store::id(),"at":now(),"chatId":chat_id,"tool":step["tool"],"label":step["label"],"decision":step["decision"],"ok":ok});
    if let Some(score) = step.get("pDeny") {
        entry["pDeny"] = score.clone();
    }
    let mut current = app.activity.lock().unwrap();
    let mut next = current.clone();
    next.insert(0, entry.clone());
    next.truncate(500);
    store::save(&app.data, "activity.v2.json", &json!(next))?;
    *current = next;
    drop(current);
    app.emit(json!({"type":"activity","entry":entry}));
    Ok(())
}

pub async fn run(
    app: &App,
    chat_id: &str,
    reply_id: &str,
    call: &Value,
    note: &str,
    request: &str,
    model: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    let name = call["name"].as_str().context("Invalid tool name")?;
    let args = &call["args"];
    let id = store::id();
    let started = now();
    let mut step = json!({"id":id,"tool":name,"args":args,"label":tools::label(name,args),"note":note,"status":"pending","at":started});
    edit_step(app, chat_id, reply_id, &id, step.clone(), true)?;
    if !tools::required(name, args) {
        edit_step(
            app,
            chat_id,
            reply_id,
            &id,
            json!({"status":"error","result":"Missing or invalid required arguments."}),
            false,
        )?;
        return Ok("error: Missing or invalid required arguments.".into());
    }
    // Approval policy can change while the model is generating. Always make
    // the decision using the current setting, rather than the turn's snapshot.
    let live_settings = app.settings.lock().unwrap().clone();
    let settings = &live_settings;
    let mode = settings["approvalMode"].as_str().unwrap_or("askAlways");
    let dangerous = liquid_core::hard_deny(name, args["command"].as_str().unwrap_or(""));
    let custom = model == "small"
        && store::load_or(&app.data, "custom-model.json", Value::Null)
            .get("file")
            .and_then(Value::as_str)
            .is_some();
    let free = name == "recall";
    let read_or_safe = [
        "read_file",
        "list_dir",
        "remember",
        "reminder",
        "clipboard",
        "set_clipboard",
        "look_at_image",
        "look_at_screen",
        "transcribe_audio",
        "recall",
        "web_search",
        "fetch_url",
        "browser_read",
    ]
    .contains(&name);
    let mut auto = free
        || (!dangerous && mode == "fullAuto" && !custom)
        || (!dangerous && mode != "askAlways" && read_or_safe);
    let mut reason = if dangerous {
        "This command can change important parts of your computer.".to_owned()
    } else {
        String::new()
    };
    let mut model_approved = false;
    let mut safety_score = None;
    if !auto && !dangerous && (mode == "approveForMe" || (mode == "fullAuto" && custom)) {
        edit_step(
            app,
            chat_id,
            reply_id,
            &id,
            json!({"status":"checking"}),
            false,
        )?;
        let history = {
            let chats = app.chats.lock().unwrap();
            chats
                .iter()
                .find(|c| c["id"] == chat_id)
                .and_then(|c| c.get("messages"))
                .and_then(Value::as_array)
                .and_then(|messages| messages.iter().find(|m| m["id"] == reply_id))
                .and_then(|m| m.get("steps"))
                .and_then(Value::as_array)
                .map(|steps| {
                    steps
                        .iter()
                        .filter(|s| s["id"] != id)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let score =
            crate::guardian::classify(app, name, args, request, &history, settings, cancel).await;
        if cancel.is_cancelled() {
            anyhow::bail!("Stopped.");
        }
        match score {
            Some(score) => {
                safety_score = Some(score);
                let rounded = (score * 1000.0).round() / 1000.0;
                step["pDeny"] = json!(rounded);
                edit_step(app, chat_id, reply_id, &id, json!({"pDeny":rounded}), false)?;
                if score < settings["guardianThreshold"].as_f64().unwrap_or(0.5) {
                    auto = true;
                    model_approved = true;
                } else {
                    reason = format!(
                        "Auto 150M wasn't sure this is safe ({}% risky).",
                        (score * 100.0).round() as u64
                    );
                }
            }
            None => reason = "Auto 150M isn't ready yet, so I need your OK.".into(),
        }
    }
    if auto && !free {
        let current = app.settings.lock().unwrap().clone();
        let changed = current["approvalMode"].as_str().unwrap_or("askAlways") != mode;
        let safety_no_longer_sufficient = model_approved
            && (!app.backends.running("guardian")
                || safety_score.is_none_or(|score| {
                    score >= current["guardianThreshold"].as_f64().unwrap_or(0.5)
                }));
        if changed || safety_no_longer_sufficient {
            auto = false;
            reason = "The approval settings changed, so I need your OK.".into();
        }
    }
    let (approved, decision) = if auto {
        (
            true,
            if free {
                "Automatic"
            } else if model_approved {
                "Auto 150M approved"
            } else if mode == "fullAuto" && !custom {
                "Full Auto"
            } else {
                "Read-only, safe"
            },
        )
    } else {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.approvals.lock().unwrap().insert(id.clone(), sender);
        if let Err(e) = edit_step(
            app,
            chat_id,
            reply_id,
            &id,
            json!({"status":"approval","reason":reason}),
            false,
        ) {
            app.approvals.lock().unwrap().remove(&id);
            return Err(e);
        }
        app.emit(json!({"type":"notify","title":"Liquid Agent needs your OK","body":step["label"],"chatId":chat_id,"kind":"approval"}));
        let approved = tokio::select! { _=cancel.cancelled()=>false, result=receiver=>result.unwrap_or(false) };
        app.approvals.lock().unwrap().remove(&id);
        if cancel.is_cancelled() {
            anyhow::bail!("Stopped.");
        }
        (
            approved,
            if approved {
                "You approved"
            } else {
                "You said no"
            },
        )
    };
    step["decision"] = json!(decision);
    if !approved {
        step["status"] = json!("denied");
        edit_step(
            app,
            chat_id,
            reply_id,
            &id,
            json!({"status":"denied","decision":decision}),
            false,
        )?;
        record(app, chat_id, &step, None)?;
        return Ok("The user said no to this action. Don't retry it; tell the user.".into());
    }
    edit_step(
        app,
        chat_id,
        reply_id,
        &id,
        json!({"status":"running","decision":decision}),
        false,
    )?;
    let result = tools::execute(app, name, args, settings, cancel).await;
    if cancel.is_cancelled() {
        edit_step(
            app,
            chat_id,
            reply_id,
            &id,
            json!({"status":"denied","result":"Stopped."}),
            false,
        )?;
        anyhow::bail!("Stopped.");
    }
    let (ok, text) = match result {
        Ok(value) => value,
        Err(e) => (
            false,
            format!(
                "error: {}",
                e.to_string().chars().take(500).collect::<String>()
            ),
        ),
    };
    step["status"] = json!(if ok { "done" } else { "error" });
    edit_step(
        app,
        chat_id,
        reply_id,
        &id,
        json!({"status":step["status"],"decision":decision,"result":text,"ms":now().saturating_sub(started)}),
        false,
    )?;
    record(app, chat_id, &step, Some(ok))?;
    Ok(text)
}
