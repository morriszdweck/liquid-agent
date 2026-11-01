//! Persistent stores using the existing on-disk JSON formats.
use rand::RngCore;
use serde_json::{json, Value};
use std::{fs, io, path::Path};

pub fn save(dir: &Path, name: &str, value: &Value) -> io::Result<()> {
    write(dir, name, &serde_json::to_vec(value)?)
}
/// Saves a list without first copying it into a JSON value, which would double the memory a big chat list takes.
pub fn save_array(dir: &Path, name: &str, items: &[Value]) -> io::Result<()> {
    write(dir, name, &serde_json::to_vec(items)?)
}
fn write(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, dir.join(name))
}
fn load(dir: &Path, name: &str) -> io::Result<Option<Value>> {
    match fs::read(dir.join(name)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub fn load_uploads(dir: &Path) -> io::Result<serde_json::Map<String, Value>> {
    match load(dir, "uploads.json")? {
        None => Ok(serde_json::Map::new()),
        Some(Value::Object(index)) => Ok(index),
        Some(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "uploads.json is not an object",
        )),
    }
}
pub fn load_or(dir: &Path, name: &str, fallback: Value) -> Value {
    load(dir, name).ok().flatten().unwrap_or(fallback)
}
fn array(dir: &Path, name: &str) -> io::Result<Option<Vec<Value>>> {
    load(dir, name)?
        .map(|v| {
            v.as_array().cloned().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{name} is not an array"),
                )
            })
        })
        .transpose()
}
pub fn load_memory(dir: &Path) -> io::Result<Vec<String>> {
    array(dir, "memory.json")?
        .unwrap_or_default()
        .into_iter()
        .map(|v| {
            v.as_str().map(str::to_owned).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "memory fact is not a string")
            })
        })
        .collect()
}
pub fn load_chats(dir: &Path) -> io::Result<Vec<Value>> {
    let mut chats = array(dir, "chats.json")?.unwrap_or_default();
    chats.retain(|chat| {
        chat.get("source").and_then(Value::as_str) != Some("voice")
            || chat
                .get("messages")
                .and_then(Value::as_array)
                .is_some_and(|messages| !messages.is_empty())
    });
    for chat in &mut chats {
        if let Some(messages) = chat.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                if message.get("status").and_then(Value::as_str) == Some("streaming") {
                    message["status"] = json!("stopped");
                }
                if let Some(steps) = message.get_mut("steps").and_then(Value::as_array_mut) {
                    for step in steps {
                        if matches!(
                            step.get("status").and_then(Value::as_str),
                            Some("pending" | "checking" | "approval" | "running")
                        ) {
                            step["status"] = json!("error");
                            step["result"] = json!("Interrupted.");
                        }
                    }
                }
            }
        }
    }
    Ok(chats)
}
pub fn load_activity(dir: &Path) -> io::Result<Vec<Value>> {
    Ok(array(dir, "activity.v2.json")?.unwrap_or_default())
}
/// The starter routines, in the language of the app. They are written once, the first time.
pub fn load_routines(dir: &Path, strings: &liquid_core::i18n::Strings) -> io::Result<Vec<Value>> {
    if let Some(routines) = array(dir, "routines.v2.json")? {
        return Ok(routines);
    }
    let mac = cfg!(target_os = "macos");
    let text = |id: &str| {
        strings
            .starters
            .iter()
            .find(|(key, _, _)| *key == id)
            .map(|(_, name, prompt)| (name.to_string(), prompt.to_string()))
            .unwrap_or_default()
    };
    let check = if mac { "check_mac" } else { "check_computer" };
    let templates = [
        ("morning", "sun", "#f5a524", "08:00", vec![1, 2, 3, 4, 5]),
        ("tidy", "folder", "#339cff", "18:00", vec![5]),
        (
            "news",
            "newspaper",
            "#a855f7",
            "12:00",
            vec![0, 1, 2, 3, 4, 5, 6],
        ),
        (check, "gauge", "#22c55e", "09:00", vec![1]),
    ];
    let routines: Vec<Value> = templates
        .into_iter()
        .map(|(key, icon, color, time, days)| {
            let (name, prompt) = text(key);
            json!({"id":id(),"name":name,"icon":icon,"color":color,"prompt":prompt,"schedule":{"enabled":false,"time":time,"days":days},"lastRun":0})
        })
        .collect();
    save(dir, "routines.v2.json", &json!(routines))?;
    Ok(routines)
}
pub fn id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes
        .iter()
        .enumerate()
        .map(|(i, b)| {
            format!(
                "{}{b:02x}",
                if [4, 6, 8, 10].contains(&i) { "-" } else { "" }
            )
        })
        .collect()
}
pub fn clean_fact(fact: &str) -> String {
    fact.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect()
}
