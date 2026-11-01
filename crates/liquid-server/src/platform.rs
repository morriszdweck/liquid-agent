//! Desktop integration using native programs, without constructing shell commands.
use anyhow::{bail, Context, Result};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

pub(crate) fn has(name: &str) -> bool {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).any(|dir| {
        std::fs::metadata(dir.join(name))
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}
pub(crate) fn desktop() -> Result<()> {
    anyhow::ensure!(
        cfg!(target_os = "macos")
            || std::env::var_os("DISPLAY").is_some_and(|s| !s.is_empty())
            || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|s| !s.is_empty()),
        "No desktop session is running here, so there's no screen, clipboard or apps to use."
    );
    Ok(())
}
fn clipboard() -> Result<(
    &'static str,
    Vec<&'static str>,
    &'static str,
    Vec<&'static str>,
)> {
    if cfg!(target_os = "macos") {
        return Ok(("pbpaste", vec![], "pbcopy", vec![]));
    }
    desktop()?;
    if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|s| !s.is_empty())
        && has("wl-paste")
        && has("wl-copy")
    {
        return Ok(("wl-paste", vec!["--no-newline"], "wl-copy", vec![]));
    }
    if std::env::var_os("DISPLAY").is_some_and(|s| !s.is_empty()) && has("xclip") {
        return Ok((
            "xclip",
            vec!["-selection", "clipboard", "-o"],
            "xclip",
            vec!["-selection", "clipboard", "-in"],
        ));
    }
    if std::env::var_os("DISPLAY").is_some_and(|s| !s.is_empty()) && has("xsel") {
        return Ok((
            "xsel",
            vec!["--clipboard", "--output"],
            "xsel",
            vec!["--clipboard", "--input"],
        ));
    }
    bail!("The clipboard needs wl-clipboard or xclip. Install it and try again.")
}
async fn command(
    program: &str,
    args: &[&str],
    input: Option<&str>,
    cancel: &CancellationToken,
) -> Result<String> {
    anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if input.is_some() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("Couldn't start {program}"))?;
    let writer = if let Some(input) = input {
        let mut stdin = child.stdin.take().context("No clipboard input")?;
        let bytes = input.as_bytes().to_owned();
        Some(tokio::spawn(async move { stdin.write_all(&bytes).await }))
    } else {
        None
    };
    let output = child.stdout.take().map(|stdout| {
        tokio::spawn(async move {
            let mut bytes = Vec::new();
            stdout.take(200_001).read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        })
    });
    let status = tokio::select! {_=cancel.cancelled()=>{let _=child.kill().await;bail!("Stopped.")},r=tokio::time::timeout(Duration::from_secs(10),child.wait())=>r.context("Desktop operation timed out")??};
    anyhow::ensure!(
        status.success(),
        "{program} failed (exit {}).",
        status.code().unwrap_or(-1)
    );
    if let Some(mut writer) = writer {
        tokio::select! {
            _ = cancel.cancelled() => { writer.abort(); bail!("Stopped."); },
            result = tokio::time::timeout(Duration::from_secs(10), &mut writer) => match result { Ok(result) => result??, Err(_) => {writer.abort(); bail!("Clipboard write timed out.");} },
        }
    }
    let bytes = if let Some(mut output) = output {
        tokio::select! {
            _ = cancel.cancelled() => {output.abort(); bail!("Stopped.");},
            result = tokio::time::timeout(Duration::from_secs(10), &mut output) => match result {Ok(result) => result??, Err(_) => {output.abort(); bail!("Clipboard read timed out.");}},
        }
    } else {
        Vec::new()
    };
    anyhow::ensure!(bytes.len() <= 200_000, "Clipboard content is too large.");
    Ok(String::from_utf8_lossy(&bytes).to_string())
}
/// Processes listening on a local TCP port, as (pid, command line).
pub(crate) async fn listeners(port: u16) -> Vec<(u32, String)> {
    let mut found = Vec::new();
    if cfg!(target_os = "macos") || !Path::new("/proc/net/tcp").exists() {
        let Ok(out) = tokio::process::Command::new("lsof")
            .args(["-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
            .output()
            .await
        else {
            return found;
        };
        for pid in String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
        {
            let command = tokio::process::Command::new("ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output()
                .await
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .unwrap_or_default();
            found.push((pid, command));
        }
        return found;
    }
    let mut inodes = std::collections::HashSet::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(table) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            // fields[1] is address:port in hex, fields[3] the state (0A = listening), fields[9] the socket inode.
            if fields.len() > 9
                && fields[3] == "0A"
                && fields[1]
                    .rsplit(':')
                    .next()
                    .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                    == Some(port)
            {
                inodes.insert(fields[9].to_owned());
            }
        }
    }
    if inodes.is_empty() {
        return found;
    }
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue; // another user's process
        };
        let owns = fds.flatten().any(|fd| {
            std::fs::read_link(fd.path())
                .ok()
                .and_then(|link| {
                    link.to_str()
                        .and_then(|s| s.strip_prefix("socket:["))
                        .and_then(|s| s.strip_suffix(']'))
                        .map(str::to_owned)
                })
                .is_some_and(|inode| inodes.contains(&inode))
        });
        if owns {
            let command = std::fs::read(entry.path().join("cmdline"))
                .map(|bytes| {
                    String::from_utf8_lossy(&bytes)
                        .split('\0')
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            found.push((pid, command));
        }
    }
    found
}

pub async fn read_clipboard(cancel: &CancellationToken) -> Result<String> {
    let (read, args, _, _) = clipboard()?;
    command(read, &args, None, cancel).await
}
pub async fn write_clipboard(text: &str, cancel: &CancellationToken) -> Result<String> {
    let (_, _, write, args) = clipboard()?;
    command(write, &args, Some(text), cancel).await?;
    Ok("Copied.".into())
}
async fn launch(program: &str, args: &[String], cancel: &CancellationToken) -> Result<()> {
    anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .with_context(|| format!("Couldn't start {program}"))?;
    tokio::select! {_=cancel.cancelled()=>{let _=child.kill().await;bail!("Stopped.")},result=tokio::time::timeout(Duration::from_millis(1500),child.wait())=>if let Ok(result)=result {let status=result?;anyhow::ensure!(status.success(),"{program} could not open it (exit {}).",status.code().unwrap_or(-1));}}
    Ok(())
}
pub async fn open_path(path: &str, cancel: &CancellationToken) -> Result<()> {
    desktop()?;
    if cfg!(target_os = "macos") {
        return launch("open", &[path.to_owned()], cancel).await;
    }
    if has("xdg-open") {
        return launch("xdg-open", &[path.to_owned()], cancel).await;
    }
    if has("gio") {
        return launch("gio", &["open".into(), path.to_owned()], cancel).await;
    }
    bail!("Opening files and links needs xdg-utils.")
}
fn find_app(name: &str) -> Option<(PathBuf, String)> {
    let wanted = name.trim().trim_end_matches(".desktop").to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    let mut dirs = vec![data.join("applications")];
    dirs.extend(
        std::env::split_paths(
            &std::env::var_os("XDG_DATA_DIRS")
                .unwrap_or_else(|| "/usr/local/share:/usr/share".into()),
        )
        .map(|d| d.join("applications")),
    );
    dirs.push(data.join("flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
    let mut close = None;
    for dir in dirs {
        for entry in std::fs::read_dir(dir).ok().into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let mut section = false;
            let mut title = "";
            let mut hidden = false;
            let mut kind = "";
            for line in text.lines() {
                if line.starts_with('[') {
                    section = line.trim() == "[Desktop Entry]";
                    continue;
                }
                if !section {
                    continue;
                }
                if let Some(v) = line.strip_prefix("Name=") {
                    title = v.trim();
                }
                if line.trim() == "NoDisplay=true" || line.trim() == "Hidden=true" {
                    hidden = true;
                }
                if let Some(v) = line.strip_prefix("Type=") {
                    kind = v.trim();
                }
            }
            if hidden || kind != "Application" {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let lower = id.to_lowercase();
            let title = title.to_lowercase();
            let matches =
                lower == wanted || lower.ends_with(&format!(".{wanted}")) || title == wanted;
            if matches {
                return Some((path.clone(), id.to_owned()));
            }
            if close.is_none() && title.contains(&wanted) {
                close = Some((path.clone(), id.to_owned()));
            }
        }
    }
    close
}
pub async fn open_app(name: &str, cancel: &CancellationToken) -> Result<()> {
    desktop()?;
    let name = name.trim();
    anyhow::ensure!(
        !name.is_empty() && !name.starts_with('-'),
        "Invalid application name."
    );
    if cfg!(target_os = "macos") {
        return launch("open", &["-a".into(), name.into()], cancel).await;
    }
    if let Some((file, id)) = find_app(name) {
        if has("gtk-launch") {
            return launch("gtk-launch", &[id], cancel).await;
        }
        if has("gio") {
            return launch(
                "gio",
                &["launch".into(), file.to_string_lossy().into_owned()],
                cancel,
            )
            .await;
        }
    }
    let bin = name
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    if bin
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b"_.+-".contains(&c))
        && has(&bin)
    {
        return launch(&bin, &[], cancel).await;
    }
    bail!("No app called “{name}” was found.")
}
pub async fn open(target: &str, expanded: &Path, cancel: &CancellationToken) -> Result<String> {
    let target = target.trim();
    anyhow::ensure!(!target.is_empty(), "Choose something to open.");
    let web = regex::Regex::new(r"(?i)^https?://|^[\w-]+(?:\.[\w-]+)+(?:/|$)")
        .unwrap()
        .is_match(target);
    if web {
        let url = crate::web::browser_url(target, cancel).await?;
        open_path(&url, cancel).await?;
    } else if expanded.exists() {
        open_path(&expanded.to_string_lossy(), cancel).await?;
    } else {
        open_app(target, cancel).await?;
    }
    Ok(format!("Opened {target}."))
}
