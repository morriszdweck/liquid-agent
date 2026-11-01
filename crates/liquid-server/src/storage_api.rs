use crate::{json_response, store, App};
use axum::{
    body::to_bytes,
    extract::Request,
    http::{Method, StatusCode},
    response::Response,
};
use serde_json::{json, Value};

async fn body(request: Request) -> Result<Value, Response> {
    let bytes = to_bytes(request.into_body(), 1_000_000)
        .await
        .map_err(|_| {
            json_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"error":"That request is too big."}),
            )
        })?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| json_response(StatusCode::BAD_REQUEST, json!({"error":"Bad JSON."})))
}
fn failure(error: std::io::Error) -> Response {
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error":error.to_string()}),
    )
}
fn missing() -> Response {
    json_response(StatusCode::NOT_FOUND, json!({"error":"Not found."}))
}

pub async fn memory(app: &App, request: Request, path: &str) -> Response {
    let method = request.method().clone();
    let index = path.strip_prefix("/api/memory/").and_then(|s| {
        if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse::<usize>().ok()
        } else {
            None
        }
    });
    if path != "/api/memory" && index.is_none() {
        return missing();
    }
    let input = if method == Method::POST || method == Method::PATCH {
        match body(request).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        json!({})
    };
    let mut current = app.memory.lock().unwrap();
    let mut next = current.clone();
    match (method, index) {
        (Method::GET, None) => return json_response(StatusCode::OK, json!(next)),
        (Method::POST, None) => {
            let text = store::clean_fact(input.get("fact").and_then(Value::as_str).unwrap_or(""));
            if !text.is_empty() && !next.iter().any(|f| f.to_lowercase() == text.to_lowercase()) {
                next.push(text);
                if next.len() > 200 {
                    next.drain(..next.len() - 200);
                }
            }
        }
        (Method::PATCH, Some(i)) => {
            if let Some(fact) = input
                .get("fact")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                if let Some(value) = next.get_mut(i) {
                    *value = fact.into();
                }
            }
        }
        (Method::DELETE, None) => next.clear(),
        (Method::DELETE, Some(i)) => {
            if i < next.len() {
                next.remove(i);
            }
        }
        _ => return missing(),
    }
    if let Err(error) = store::save(&app.data, "memory.json", &json!(next)) {
        return failure(error);
    }
    *current = next.clone();
    app.emit(json!({"type":"memory","facts":next}));
    json_response(StatusCode::OK, json!(next))
}

pub async fn routines(app: &App, request: Request, path: &str) -> Response {
    let method = request.method().clone();
    let id = path.strip_prefix("/api/routines/").filter(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    });
    if path != "/api/routines" && id.is_none() {
        return missing();
    }
    let input = if method == Method::POST || method == Method::PATCH {
        match body(request).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        json!({})
    };
    let mut current = app.routines.lock().unwrap();
    let mut next = current.clone();
    let result = match (method, id) {
        (Method::GET, None) => return json_response(StatusCode::OK, json!(next)),
        (Method::POST, None) => {
            let base = json!({"id":store::id(),"name":"New routine","icon":"sparkles","color":"#339cff","prompt":"","schedule":{"enabled":false,"time":"09:00","days":[1,2,3,4,5]},"lastRun":0});
            let routine = liquid_core::routines::clean(&input, &base);
            if routine
                .get("prompt")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error":"Write what the routine should do."}),
                );
            }
            next.push(routine.clone());
            routine
        }
        (Method::PATCH, Some(id)) => {
            let Some(index) = next
                .iter()
                .position(|routine| routine.get("id").and_then(Value::as_str) == Some(id))
            else {
                return missing();
            };
            let routine = liquid_core::routines::clean(&input, &next[index]);
            next[index] = routine.clone();
            routine
        }
        (Method::DELETE, Some(id)) => {
            next.retain(|routine| routine.get("id").and_then(Value::as_str) != Some(id));
            json!({"ok":true})
        }
        _ => return missing(),
    };
    if let Err(error) = store::save(&app.data, "routines.v2.json", &json!(next)) {
        return failure(error);
    }
    *current = next;
    app.emit(json!({"type":"routines","routines":*current}));
    json_response(StatusCode::OK, result)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn attachments(chat: &Value) -> Vec<String> {
    chat.get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|message| {
            message
                .get("attachments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|file| file.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

pub async fn chats(app: &App, request: Request, path: &str) -> Response {
    let method = request.method().clone();
    if method == Method::POST {
        if let Some((id, action)) = path
            .strip_prefix("/api/chats/")
            .and_then(|part| part.split_once('/'))
        {
            if !id.is_empty()
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                && ["send", "edit", "regenerate", "stop"].contains(&action)
            {
                if action == "stop" {
                    return crate::chat::stop(app, id);
                }
                if action == "send" {
                    return match body(request).await {
                        Ok(input) => crate::chat::send(app, Some(id), &input),
                        Err(response) => response,
                    };
                }
                if action == "edit" {
                    return match body(request).await {
                        Ok(input) => crate::chat::revise(app, id, &input, "edit"),
                        Err(response) => response,
                    };
                }
                if action == "regenerate" {
                    return crate::chat::revise(app, id, &json!({}), "regenerate");
                }
            }
        }
    }
    let id = path.strip_prefix("/api/chats/").filter(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    });
    if path != "/api/chats" && id.is_none() {
        return missing();
    }
    let input = if method == Method::POST || method == Method::PATCH {
        match body(request).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        json!({})
    };
    if method == Method::POST
        && id.is_none()
        && (input
            .get("text")
            .is_some_and(|v| !v.is_null() && v != "" && v != false && v != 0)
            || input
                .get("attachments")
                .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty())))
    {
        return crate::chat::send(app, None, &input);
    }
    let running = app.running.lock().unwrap();
    let mut current = app.chats.lock().unwrap();
    let mut next = current.clone();
    let result = match (method, id) {
        (Method::GET, None) => return json_response(StatusCode::OK, json!(next)),
        (Method::POST, None) => {
            let now = now_ms();
            let chat = json!({"id":store::id(),"title":"New chat","createdAt":now,"updatedAt":now,"pinned":false,"messages":[]});
            next.insert(0, chat.clone());
            chat
        }
        (Method::PATCH, Some(id)) => {
            let Some(chat) = next
                .iter_mut()
                .find(|chat| chat.get("id").and_then(Value::as_str) == Some(id))
            else {
                return missing();
            };
            if let Some(title) = input
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                chat["title"] = json!(title.chars().take(80).collect::<String>());
                chat["named"] = json!(true);
            }
            if let Some(pinned) = input.get("pinned").and_then(Value::as_bool) {
                chat["pinned"] = json!(pinned);
            }
            chat["updatedAt"] = json!(now_ms());
            chat.clone()
        }
        (Method::DELETE, target) => {
            let deleted: Vec<String> = next
                .iter()
                .filter_map(|chat| chat.get("id").and_then(Value::as_str))
                .filter(|id| target.is_none_or(|target| target == *id))
                .map(str::to_owned)
                .collect();
            let removed_files: Vec<String> = next
                .iter()
                .filter(|chat| {
                    deleted
                        .iter()
                        .any(|id| chat.get("id").and_then(Value::as_str) == Some(id))
                })
                .flat_map(attachments)
                .collect();
            next.retain(|chat| {
                !deleted
                    .iter()
                    .any(|id| chat.get("id").and_then(Value::as_str) == Some(id))
            });
            let still_used: std::collections::HashSet<String> =
                next.iter().flat_map(attachments).collect();
            let mut uploads = app.uploads.lock().unwrap();
            let mut next_uploads = uploads.clone();
            let records: Vec<Value> = removed_files
                .iter()
                .filter(|id| !still_used.contains(*id))
                .filter_map(|id| next_uploads.remove(id))
                .collect();
            let paths = match crate::uploads::removal_paths(&app.data, &records) {
                Ok(paths) => paths,
                Err(_) => {
                    return json_response(
                        StatusCode::CONFLICT,
                        json!({"error":"An attachment has an unsafe path; the chat was not deleted."}),
                    )
                }
            };
            for id in &deleted {
                if let Some(token) = running.get(id) {
                    token.cancel();
                }
            }
            if let Err(error) = store::save(&app.data, "chats.json", &json!(next)) {
                return failure(error);
            }
            *current = next;
            for id in deleted {
                app.emit(json!({"type":"chat.deleted","id":id}));
            }
            if !records.is_empty() {
                if let Err(error) = store::save(
                    &app.data,
                    "uploads.json",
                    &Value::Object(next_uploads.clone()),
                ) {
                    return failure(error);
                }
                *uploads = next_uploads;
                for path in paths {
                    let _ = std::fs::remove_file(&path);
                    let _ = std::fs::remove_file(format!("{}.txt", path.display()));
                }
            }
            return json_response(StatusCode::OK, json!({"ok":true}));
        }
        _ => return missing(),
    };
    if let Err(error) = store::save(&app.data, "chats.json", &json!(next)) {
        return failure(error);
    }
    *current = next;
    app.emit(json!({"type":"chat","chat":result}));
    json_response(StatusCode::OK, result)
}
