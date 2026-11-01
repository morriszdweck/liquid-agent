//! Atomic app update handover and rollback.
use anyhow::{Context, Result};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

fn alive(pid: i32) -> bool {
    // A zero signal only checks whether the process exists; EPERM means it does.
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}
fn sibling(app: &Path, suffix: &str) -> PathBuf {
    let mut name = app.as_os_str().to_os_string();
    name.push(suffix);
    name.into()
}
fn remove(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn start(server: &str, app: &Path, args: &[String]) -> Result<Child> {
    Ok(Command::new(app.join("bin").join(server))
        .args(args)
        .env("LIQUID_AGENT_ROOT", app)
        .stdin(Stdio::null())
        .spawn()?)
}
fn healthy(port: u16, build: u64) -> bool {
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
    if socket.read_to_string(&mut response).is_err() {
        return false;
    }
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !headers.starts_with("HTTP/1.1 200 ") && !headers.starts_with("HTTP/1.0 200 ") {
        return false;
    }
    serde_json::from_str::<Value>(body)
        .is_ok_and(|v| v["app"] == "liquid-agent" && v["build"].as_u64() == Some(build))
}

pub fn run(args: Vec<String>) -> Result<()> {
    anyhow::ensure!(
        args.len() >= 5,
        "usage: --handover PID APP SERVER PORT BUILD [ARGS...]"
    );
    let pid: i32 = args[0].parse()?;
    anyhow::ensure!(pid > 1, "invalid old server PID");
    let app = Path::new(&args[1]);
    let server = &args[2];
    anyhow::ensure!(
        !server.contains('/') && server.starts_with("liquid-server-"),
        "invalid server name"
    );
    let port: u16 = args[3].parse()?;
    let build: u64 = args[4].parse()?;
    let server_args = &args[5..];
    let old = sibling(app, ".old");
    let next = sibling(app, ".next");
    let bad = sibling(app, ".bad");
    for _ in 0..100 {
        if !alive(pid) {
            break;
        }
        sleep(Duration::from_millis(200));
    }
    anyhow::ensure!(
        !alive(pid),
        "The old server did not stop; update cancelled."
    );
    remove(&old)?;
    if let Err(error) = fs::rename(app, &old) {
        eprintln!(
            "{}",
            liquid_core::i18n::diag_language()
                .move_old
                .replace("{error}", &error.to_string())
        );
        start(server, app, server_args)?;
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&next, app) {
        eprintln!(
            "{}",
            liquid_core::i18n::diag_language()
                .install_update
                .replace("{error}", &error.to_string())
        );
        fs::rename(&old, app)?;
        start(server, app, server_args)?;
        return Err(error.into());
    }
    let mut child = match start(server, app, server_args) {
        Ok(child) => Some(child),
        Err(error) => {
            eprintln!(
                "{}",
                liquid_core::i18n::diag_language()
                    .start_updated
                    .replace("{error}", &error.to_string())
            );
            None
        }
    };
    for _ in 0..120 {
        if healthy(port, build) {
            remove(&old)?;
            println!(
                "{}",
                liquid_core::i18n::diag_language()
                    .updated
                    .replace("{build}", &build.to_string())
            );
            return Ok(());
        }
        if child
            .as_mut()
            .map(|c| c.try_wait().ok().flatten().is_some())
            .unwrap_or(true)
        {
            break;
        }
        sleep(Duration::from_millis(500));
    }
    eprintln!(
        "{}",
        liquid_core::i18n::diag_language()
            .build_not_started
            .replace("{build}", &build.to_string())
    );
    if let Some(ref mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    remove(&bad)?;
    fs::rename(app, &bad).context("could not move failed update")?;
    fs::rename(&old, app).context("could not restore previous app")?;
    start(server, app, server_args).context("could not restart previous app")?;
    Ok(())
}
