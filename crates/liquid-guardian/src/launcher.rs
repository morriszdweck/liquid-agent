//! Installed command launcher. Configuration is written by the installer.
use anyhow::{Context, Result};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

pub fn run() -> Result<()> {
    let executable = std::env::current_exe()?;
    let config_path = executable
        .parent()
        .context("launcher has no directory")?
        .join("launcher.json");
    let config: Value = serde_json::from_slice(&fs::read(config_path)?)?;
    let get = |key| -> Result<&str> {
        config
            .get(key)
            .and_then(Value::as_str)
            .with_context(|| format!("missing launcher setting: {key}"))
    };
    let root = get("root")?;
    let data = get("data")?;
    let port: u16 = get("port")?.parse()?;
    // The app itself lives in <root>/app; the bin folder beside this launcher holds only the launcher.
    let app = Path::new(root).join("app");
    let server = app.join("bin").join(format!("liquid-server-{}", native()));
    let log = Path::new(data).join("logs/server.log");
    match std::env::args().nth(1).as_deref().unwrap_or("open") {
        "open" => {
            let mac_app = Path::new("/Applications/Liquid Agent.app/Contents/MacOS/Liquid Agent");
            if cfg!(target_os = "macos") && mac_app.exists() {
                Command::new("open")
                    .args(["-a", "/Applications/Liquid Agent.app"])
                    .spawn()?;
            } else if running(port) {
                let url = format!("http://127.0.0.1:{port}");
                if cfg!(target_os = "macos") {
                    Command::new("open").arg(url).spawn()?;
                } else if std::env::var_os("DISPLAY").is_some()
                    || std::env::var_os("WAYLAND_DISPLAY").is_some()
                {
                    let _ = Command::new("xdg-open")
                        .arg(&url)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn();
                } else {
                    println!("Open {url} in your browser.");
                }
            } else {
                println!("Starting Liquid Agent at http://127.0.0.1:{port}");
                fs::create_dir_all(log.parent().unwrap())?;
                let output = OpenOptions::new().create(true).append(true).open(&log)?;
                Command::new(&server)
                    .arg("--open")
                    .env("LIQUID_AGENT_PORT", port.to_string())
                    .env("LIQUID_AGENT_HOME", data)
                    .env("LIQUID_AGENT_ROOT", &app)
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(output.try_clone()?))
                    .stderr(Stdio::from(output))
                    .spawn()?;
            }
        }
        "stop" => {
            let escaped: String = server
                .to_string_lossy()
                .chars()
                .flat_map(|c| {
                    if ".+*?()[]{}^$|\\".contains(c) {
                        vec!['\\', c]
                    } else {
                        vec![c]
                    }
                })
                .collect();
            let pattern = format!("^{} *( |$)", escaped);
            let status = Command::new("pkill").args(["-f", &pattern]).status()?;
            println!(
                "{}",
                if status.success() {
                    "Stopped."
                } else {
                    "It wasn't running."
                }
            );
        }
        "logs" => {
            let contents = fs::read_to_string(log).unwrap_or_default();
            let lines: Vec<_> = contents.lines().collect();
            for line in &lines[lines.len().saturating_sub(80)..] {
                println!("{line}");
            }
        }
        "update" => {
            let url = format!(
                "https://raw.githubusercontent.com/{}/{}/install.sh",
                get("repo")?,
                get("branch")?
            );
            let mut curl = Command::new("curl")
                .args(["-fsSL", &url])
                .stdout(Stdio::piped())
                .spawn()?;
            let input = curl.stdout.take().context("cannot read installer")?;
            let mut bash = Command::new("bash").stdin(Stdio::from(input)).spawn()?;
            let shell_status = bash.wait()?;
            let curl_status = curl.wait()?;
            anyhow::ensure!(
                shell_status.success() && curl_status.success(),
                "installation update failed"
            );
        }
        _ => println!("Use: liquid-agent [open|stop|update|logs]"),
    }
    Ok(())
}

/// The platform name the installer uses for bundled binaries ("darwin-arm64").
fn native() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn running(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut socket) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
    if write!(
        socket,
        "GET /healthz HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut response = String::new();
    socket.read_to_string(&mut response).is_ok()
        && response
            .split_once("\r\n\r\n")
            .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
            .and_then(|body| body.get("app").and_then(Value::as_str).map(str::to_owned))
            .as_deref()
            == Some("liquid-agent")
}
