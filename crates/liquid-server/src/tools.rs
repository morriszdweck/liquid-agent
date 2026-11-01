//! Local tools and the human approval boundary for the Rust agent.
use crate::{json_response, store, App};
use anyhow::{Context, Result};
use axum::{body::to_bytes, extract::Request, http::StatusCode, response::Response};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio_util::sync::CancellationToken;

pub fn descriptors(browser: bool, omni: bool) -> Value {
    let mut value = json!({
        "shell":{"params":[{"name":"command"}]}, "read_file":{"params":[{"name":"path"}]},
        "write_file":{"params":[{"name":"path"},{"name":"content"}]}, "list_dir":{"params":[{"name":"path","required":false}]},
        "remember":{"params":[{"name":"fact"}]}, "recall":{"params":[{"name":"query"}]},
        "web_search":{"params":[{"name":"query"}]}, "fetch_url":{"params":[{"name":"url"}]},
        "reminder":{"params":[{"name":"text"},{"name":"minutes"}]},
        "open":{"params":[{"name":"target"}]}, "clipboard":{"params":[]}, "set_clipboard":{"params":[{"name":"text"}]}
    });
    if omni {
        value.as_object_mut().unwrap().extend(json!({"look_at_image":{"params":[{"name":"path"},{"name":"question","required":false}]},"look_at_screen":{"params":[{"name":"question","required":false}]},"transcribe_audio":{"params":[{"name":"path"}]}}).as_object().unwrap().clone());
    }
    if browser {
        value.as_object_mut().unwrap().extend(json!({
        "browser_goto":{"params":[{"name":"url"}]}, "browser_read":{"params":[]},
        "browser_click":{"params":[{"name":"target"}]}, "browser_type":{"params":[{"name":"target"},{"name":"text"}]}
    }).as_object().unwrap().clone());
    }
    value
}
/// The tool-call protocol and the tools. Tool names and parameters stay in English: they are what the models answer with.
pub fn prompt(s: &liquid_core::i18n::Strings) -> String {
    format!(
        "{}\n<tool_call>\n<function=NAME>\n<parameter=ARG>\nVALUE\n</parameter>\n</function>\n</tool_call>\n{}\n- shell(command) run a shell command\n- read_file(path) read a text file\n- write_file(path, content) create or overwrite a text file\n- list_dir(path) list a folder\n- remember(fact) save a lasting fact about the user\n- recall(query) search saved facts\n- web_search(query) search the web\n- fetch_url(url) read a public web page\n- reminder(text, minutes) set a reminder\n- open(target) open an app, file or website\n- clipboard() read the clipboard\n- set_clipboard(text) copy text to the clipboard\n{}",
        s.tools_intro, s.tools_list, s.tools_after
    )
}
/// The picture and audio tools, when the multimodal model is running.
pub fn vision_prompt(s: &liquid_core::i18n::Strings) -> String {
    format!("\n{}\n- look_at_image(path, question) inspect an image\n- look_at_screen(question) inspect the screen\n- transcribe_audio(path) transcribe an audio file", s.media_tools)
}
/// The browser tools, when the Web helper is running.
pub fn browser_prompt(s: &liquid_core::i18n::Strings) -> String {
    format!("\n{}\n- browser_goto(url) open a public web page\n- browser_read() read the current page\n- browser_click(target) click visible text or a selector\n- browser_type(target, text) fill a field", s.browser_tools)
}
fn error(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}
pub async fn approval(app: &App, request: Request, path: &str) -> Response {
    let Some(id) = path.strip_prefix("/api/approvals/").filter(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    }) else {
        return error(StatusCode::NOT_FOUND, "Not found.");
    };
    let body = match to_bytes(request.into_body(), 1_000_000).await {
        Ok(body) => body,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "That request is too big."),
    };
    let input: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Bad JSON."),
    };
    let Some(approved) = input.get("approve").and_then(Value::as_bool) else {
        return error(StatusCode::BAD_REQUEST, "Approval must be true or false.");
    };
    let sender = app.approvals.lock().unwrap().remove(id);
    if sender.is_some_and(|sender| sender.send(approved).is_ok()) {
        json_response(StatusCode::OK, json!({"ok":true}))
    } else {
        error(StatusCode::NOT_FOUND, "Not found.")
    }
}
/// The label of a tool call, in the language of the chat.
pub fn label(strings: &liquid_core::i18n::Strings, name: &str, args: &Value) -> String {
    liquid_core::i18n::label(strings, name, args)
}
pub fn required(name: &str, args: &Value) -> bool {
    let keys: &[&str] = match name {
        "shell" => &["command"],
        "read_file" => &["path"],
        "write_file" => &["path", "content"],
        "list_dir" => &[],
        "remember" => &["fact"],
        "recall" => &["query"],
        "open" => &["target"],
        "clipboard" => &[],
        "look_at_image" | "transcribe_audio" => &["path"],
        "look_at_screen" => &[],
        "set_clipboard" => &["text"],
        "reminder" => {
            return args["text"].is_string()
                && (args["minutes"]
                    .as_f64()
                    .or_else(|| args["minutes"].as_str().and_then(|s| s.parse().ok())))
                .is_some_and(|n| n > 0.0 && n.is_finite());
        }
        "web_search" => &["query"],
        "fetch_url" => &["url"],
        "browser_goto" => &["url"],
        "browser_read" => &[],
        "browser_click" => &["target"],
        "browser_type" => &["target", "text"],
        _ => return false,
    };
    keys.iter()
        .all(|key| args.get(*key).is_some_and(Value::is_string))
}
fn expand(settings: &Value, input: &str) -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let expand_home = |s: &str| {
        if s == "~" {
            home.clone()
        } else if let Some(s) = s.strip_prefix("~/") {
            home.join(s)
        } else {
            PathBuf::from(s)
        }
    };
    let base = settings["workspace"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(&expand_home)
        .unwrap_or_else(|| home.clone());
    let target = if input.trim().is_empty() {
        base
    } else {
        base.join(expand_home(input.trim()))
    };
    if target.is_absolute() {
        target
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(target)
    }
}
async fn drain(mut input: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = input.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        let remaining = 200_000usize.saturating_sub(result.len());
        result.extend_from_slice(&buffer[..n.min(remaining)]);
    }
    Ok(result)
}
async fn shell(command: &str, cwd: &Path, cancel: &CancellationToken) -> Result<String> {
    use std::os::unix::process::CommandExt;
    let own = std::env::var("SHELL").unwrap_or_default();
    let shell = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else if (own.ends_with("/bash") || own.ends_with("/zsh")) && Path::new(&own).is_file() {
        &own
    } else if Path::new("/bin/bash").is_file() {
        "/bin/bash"
    } else {
        "/bin/sh"
    };
    let mut builder = tokio::process::Command::new(shell);
    builder.as_std_mut().process_group(0);
    let mut child = builder
        .arg(if shell.ends_with("/sh") { "-c" } else { "-lc" })
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = tokio::spawn(drain(child.stdout.take().context("missing stdout")?));
    let stderr = tokio::spawn(drain(child.stderr.take().context("missing stderr")?));
    let pid = child.id();
    let mut group = ShellGroup(pid);
    let status = tokio::select! { _=cancel.cancelled()=>{terminate_group(group.0.take()); let _=child.kill().await; anyhow::bail!("Stopped.")}, result=tokio::time::timeout(Duration::from_secs(60),child.wait())=>match result {Ok(status)=>status?,Err(_)=>{terminate_group(group.0.take()); let _=child.kill().await; anyhow::bail!("Timed out after 60 seconds.")} } };
    let output = async {
        let mut bytes = stdout.await??;
        bytes.extend(stderr.await??);
        Ok::<_, anyhow::Error>(bytes)
    };
    let bytes = tokio::select! {
        _ = cancel.cancelled() => { terminate_group(group.0.take()); anyhow::bail!("Stopped."); },
        result = tokio::time::timeout(Duration::from_secs(60), output) => match result { Ok(result) => result?, Err(_) => { terminate_group(group.0.take()); anyhow::bail!("Timed out after 60 seconds."); } }
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    group.0 = None;
    Ok(if status.success() {
        text
    } else {
        format!("exit {}\n{text}", status.code().unwrap_or(-1))
    })
}
struct ShellGroup(Option<u32>);
impl Drop for ShellGroup {
    fn drop(&mut self) {
        terminate_group(self.0);
    }
}
fn terminate_group(pid: Option<u32>) {
    if let Some(pid) = pid
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
    {
        // The shell was placed in a separate process group when spawned.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
}
async fn browser(
    app: &App,
    name: &str,
    args: &Value,
    cancel: &CancellationToken,
) -> Result<String> {
    anyhow::ensure!(
        app.backends.running("browser"),
        "The Web helper is not running."
    );
    let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    let (action, body) = match name {
        "browser_goto" => (
            "goto",
            json!({"url":crate::web::browser_url(arg("url"), cancel).await?}),
        ),
        "browser_read" => ("read", json!({})),
        "browser_click" => ("click", json!({"target":arg("target")})),
        "browser_type" => ("type", json!({"target":arg("target"),"text":arg("text")})),
        _ => anyhow::bail!("Unknown browser action."),
    };
    anyhow::ensure!(
        app.backends.running("browser"),
        "The Web helper is not running."
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()?;
    let request = client
        .post(format!(
            "http://127.0.0.1:{}/{action}",
            crate::backends::port("browser")
        ))
        .header("x-liquid-bridge-token", &app.token)
        .json(&body)
        .send();
    let response =
        tokio::select! { _=cancel.cancelled()=>anyhow::bail!("Stopped."), result=request=>result? };
    anyhow::ensure!(
        response.status().is_success(),
        "Web helper request failed ({}).",
        response.status()
    );
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! { _=cancel.cancelled()=>anyhow::bail!("Stopped."), chunk=stream.next()=>chunk };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        anyhow::ensure!(
            bytes.len() + chunk.len() <= 200_000,
            "Web helper response is too large."
        );
        bytes.extend_from_slice(&chunk);
    }
    let result: Value = serde_json::from_slice(&bytes)?;
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        anyhow::bail!("{error}");
    }
    Ok(result
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned())
}
pub async fn execute(
    app: &App,
    name: &str,
    args: &Value,
    settings: &Value,
    cancel: &CancellationToken,
) -> Result<(bool, String)> {
    anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
    let output = match name {
        "shell" => shell(arg("command"), &expand(settings, ""), cancel).await?,
        "open" => {
            crate::platform::open(arg("target"), &expand(settings, arg("target")), cancel).await?
        }
        "clipboard" => crate::platform::read_clipboard(cancel).await?,
        "look_at_image" | "look_at_screen" | "transcribe_audio" => {
            crate::vision_tools::execute(
                app,
                name,
                &expand(settings, arg("path")),
                arg("question"),
                cancel,
            )
            .await?
        }
        "set_clipboard" => crate::platform::write_clipboard(arg("text"), cancel).await?,
        "web_search" => crate::web::search(arg("query"), cancel).await?,
        "reminder" => crate::scheduler::reminder(
            app,
            arg("text"),
            args["minutes"]
                .as_f64()
                .or_else(|| args["minutes"].as_str().and_then(|s| s.parse().ok()))
                .unwrap_or(10.0),
        )?,
        "fetch_url" => crate::web::fetch(arg("url"), cancel).await?,
        "browser_goto" | "browser_read" | "browser_click" | "browser_type" => {
            browser(app, name, args, cancel).await?
        }
        "read_file" => {
            let path = expand(settings, arg("path"));
            let meta = tokio::fs::metadata(&path).await?;
            if meta.is_dir() {
                format!("{} is a folder. Use list_dir.", path.display())
            } else if meta.len() > 2_000_000 {
                format!("{} is too big to read.", path.display())
            } else {
                let bytes = tokio::fs::read(&path).await?;
                if bytes.iter().take(4000).any(|b| *b == 0) {
                    format!("{} is not a text file.", path.display())
                } else {
                    String::from_utf8_lossy(&bytes).into_owned()
                }
            }
        }
        "write_file" => {
            let path = expand(settings, arg("path"));
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
            tokio::fs::write(&path, arg("content")).await?;
            format!("Saved {} ({} bytes).", path.display(), arg("content").len())
        }
        "list_dir" => {
            let dir = expand(settings, arg("path"));
            let mut reader = tokio::fs::read_dir(&dir).await?;
            let mut lines = Vec::new();
            let mut count = 0;
            while let Some(entry) = reader.next_entry().await? {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                count += 1;
                if lines.len() < 120 {
                    lines.push(if entry.file_type().await?.is_dir() {
                        format!("{name}/")
                    } else {
                        name
                    });
                }
            }
            if count > 120 {
                lines.push(format!("…and {} more", count - 120));
            }
            format!(
                "{} ({count} items)\n{}",
                dir.display(),
                if lines.is_empty() {
                    "(empty)".into()
                } else {
                    lines.join("\n")
                }
            )
        }
        "recall" => {
            let facts = app.memory.lock().unwrap();
            let hits = liquid_core::memory::search(&facts, arg("query"), 8);
            if hits.is_empty() {
                "Nothing saved about that.".into()
            } else {
                hits.join("\n")
            }
        }
        "remember" => {
            let text = store::clean_fact(arg("fact"));
            let mut facts = app.memory.lock().unwrap();
            if text.is_empty()
                || facts
                    .iter()
                    .any(|f| f.to_lowercase() == text.to_lowercase())
            {
                "Already known.".into()
            } else {
                let mut next = facts.clone();
                next.push(text);
                if next.len() > 200 {
                    next.remove(0);
                }
                store::save(&app.data, "memory.json", &json!(next))?;
                *facts = next.clone();
                app.emit(json!({"type":"memory","facts":next}));
                "Saved.".into()
            }
        }
        _ => anyhow::bail!("Unknown tool."),
    };
    let output = output.trim();
    let output = if output.is_empty() {
        "(no output)"
    } else {
        output
    };
    let limit = settings["toolOutputLimit"]
        .as_u64()
        .unwrap_or(1200)
        .clamp(1, 200_000) as usize
        * if name == "read_file" || name == "transcribe_audio" {
            3
        } else {
            1
        };
    let chars = output.chars().count();
    let text = if chars > limit {
        format!(
            "{}\n…({} more characters cut)",
            output.chars().take(limit).collect::<String>(),
            chars - limit
        )
    } else {
        output.to_owned()
    };
    Ok((
        !text.starts_with("error:") && !text.starts_with("exit "),
        text,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_tools_require_omni_availability() {
        for name in ["look_at_image", "look_at_screen", "transcribe_audio"] {
            assert!(descriptors(false, false).get(name).is_none());
            assert!(descriptors(false, true).get(name).is_some());
        }
    }
    #[tokio::test]
    async fn stopping_shell_stops_descendants() {
        let dir = std::env::temp_dir().join(format!("liquid-tool-test-{}", store::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let cwd = dir.clone();
        let task = tokio::spawn(async move {
            shell("(sleep 1; printf late > result) & wait", &cwd, &token).await
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        cancel.cancel();
        assert!(task.await.unwrap().is_err());
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!dir.join("result").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
