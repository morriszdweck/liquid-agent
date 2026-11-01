//! Liquid Agent for macOS: a native window onto the Liquid Agent that runs on this
//! computer. It starts that copy (installing it the first time, with the same
//! installer as the one-line command) and shows it. The agent updates itself, so
//! this shell rarely needs a new version.

use anyhow::{Context, Result};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::{Window, WindowBuilder},
};
use wry::{NewWindowResponse, PermissionResponse, WebView, WebViewBuilder};

/// The port the server listens on (LIQUID_AGENT_PORT, as the server reads it).
fn port() -> u16 {
    std::env::var("LIQUID_AGENT_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8170)
}

fn origin() -> String {
    format!("http://127.0.0.1:{}", port())
}

const INSTALLER: &str =
    "https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh";
const WEBSITE: &str = "https://liquid-agent.mincoffical.codes";
/// The first-run screen: the TypeScript in desktop/setup, built by `npm run build:setup`.
const SETUP_HTML: &str = include_str!("../../../desktop/setup-dist/index.html");
const SETUP_JS: &str = include_str!("../../../desktop/setup-dist/setup.js");

/// Things the background work asks the window to do.
#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Ui {
    Say(String),
    Failed(String),
    Show(String),
    Drag,
    Reopen,
    Reload,
    Website,
    Quit,
}

/// The server this window started, so quitting stops it (a copy started from the command line keeps running).
static STARTED: Mutex<Option<u32>> = Mutex::new(None);

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| ".".into()))
}

/// Where the app keeps its files (the same place the server and installer use).
fn data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/LiquidAgent")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/share"))
            .join("liquid-agent")
    }
}

/// The installed copy: ~/.liquid-agent/app, with bin/liquid-server-<platform>.
fn app_root() -> PathBuf {
    home().join(".liquid-agent").join("app")
}

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

fn server_binary() -> PathBuf {
    app_root()
        .join("bin")
        .join(format!("liquid-server-{}", native()))
}

/// Does a Liquid Agent answer on the port?
fn running() -> bool {
    let port = port();
    let Ok(mut socket) = TcpStream::connect(("127.0.0.1", port)) else {
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
    socket.read_to_string(&mut response).is_ok() && response.contains("\"app\":\"liquid-agent\"")
}

fn wait_until_running(within: Duration) -> bool {
    let until = Instant::now() + within;
    while Instant::now() < until {
        if running() {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

/// Runs the one-line installer, showing what it prints on the setup screen.
fn install(proxy: &EventLoopProxy<Ui>) -> Result<()> {
    let mut child = Command::new("/bin/bash")
        .arg("-c")
        .arg(format!("curl -fsSL {INSTALLER} | bash 2>&1"))
        .env("LIQUID_AGENT_NO_OPEN", "1")
        .env("LIQUID_AGENT_DESKTOP", "1")
        .env("LIQUID_AGENT_PORT", port().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("Couldn't start the installer.")?;
    let mut last = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let text = strip_ansi(&line);
            let text = text.trim_start_matches('→').trim().to_owned();
            if text.is_empty() {
                continue;
            }
            last.push(text.clone());
            let _ = proxy.send_event(Ui::Say(text));
        }
    }
    let status = child.wait()?;
    anyhow::ensure!(
        status.success(),
        "{}",
        last.last()
            .cloned()
            .unwrap_or_else(|| "The installer stopped.".into())
    );
    Ok(())
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Starts the installed server, detached, with its log in the data folder.
fn start_server() -> Result<()> {
    let data = data_dir();
    fs::create_dir_all(data.join("logs"))?;
    let log = data.join("logs").join("server.log");
    let open = || OpenOptions::new().create(true).append(true).open(&log);
    let child = Command::new(server_binary())
        .env("LIQUID_AGENT_PORT", port().to_string())
        .env("LIQUID_AGENT_HOME", &data)
        .env("LIQUID_AGENT_ROOT", app_root())
        .stdin(Stdio::null())
        .stdout(open()?)
        .stderr(open()?)
        .process_group(0)
        .spawn()
        .context("Couldn't start Liquid Agent.")?;
    *STARTED.lock().unwrap() = Some(child.id());
    Ok(())
}

/// Shows the setup screen, sets Liquid Agent up if needed, starts it and shows the app.
fn open(proxy: EventLoopProxy<Ui>) {
    let say = |text: &str| {
        let _ = proxy.send_event(Ui::Say(text.into()));
    };
    let fail = |message: String| {
        let _ = proxy.send_event(Ui::Failed(message));
    };
    if running() {
        let _ = proxy.send_event(Ui::Show(origin()));
        return;
    }
    if !server_binary().exists() {
        say("Setting up Liquid Agent. This takes a minute the first time.");
        if let Err(e) = install(&proxy) {
            return fail(e.to_string());
        }
    }
    if !running() {
        say("Starting Liquid Agent…");
        if let Err(e) = start_server() {
            return fail(e.to_string());
        }
    }
    if !wait_until_running(Duration::from_secs(60)) {
        let log = data_dir().join("logs").join("server.log");
        return fail(format!(
            "Liquid Agent didn't start. Its log is in {}.",
            log.display()
        ));
    }
    let _ = proxy.send_event(Ui::Show(origin()));
}

/// Only one window at a time: a second copy exits, and the first keeps running.
fn single_instance(data: &Path) -> Result<Option<fs::File>> {
    fs::create_dir_all(data)?;
    let file = fs::File::create(data.join("desktop.lock"))?;
    let locked = unsafe {
        libc::flock(
            std::os::unix::io::AsRawFd::as_raw_fd(&file),
            libc::LOCK_EX | libc::LOCK_NB,
        )
    } == 0;
    Ok(locked.then_some(file))
}

/// Opens a link in the default browser; links never load inside the app.
fn open_external(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = Command::new(opener)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/// The title bar: the top bars move the window (the web UI styles the bars for the Mac app).
const TITLE_BAR_JS: &str = r#"
(() => {
  if (location.protocol !== "http:") return;
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    if (!e.target.closest || !e.target.closest(".sidebar-head, .topbar")) return;
    if (e.target.closest('button, a, input, select, textarea, [role="button"], .topbar-title')) return;
    window.ipc.postMessage("drag");
  }, true);
})();
"#;

fn build_webview(window: &Window, proxy: EventLoopProxy<Ui>) -> wry::Result<WebView> {
    // The setup screen is inlined, so it works without any file paths or module loading.
    let html = SETUP_HTML
        .replace(
            "<script src=\"./setup.js\"></script>",
            &format!("<script>{SETUP_JS}</script>"),
        )
        .replace("script-src 'self'", "script-src 'unsafe-inline'");
    let drag = proxy.clone();
    let builder = WebViewBuilder::new()
        .with_html(html)
        .with_initialization_script(TITLE_BAR_JS)
        .with_ipc_handler(move |request| {
            if request.body() == "drag" {
                let _ = drag.send_event(Ui::Drag);
            }
        })
        .with_navigation_handler(|url| {
            if url.starts_with("http://") || url.starts_with("https://") {
                if url.starts_with(&origin()) {
                    return true;
                }
                open_external(&url);
                return false;
            }
            true
        })
        .with_new_window_req_handler(|url, _| {
            open_external(&url);
            NewWindowResponse::Deny
        })
        // Microphone and camera, for voice chat and "look at me" (only this app's page ever asks).
        .with_permission_handler(|_| PermissionResponse::Allow);
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::WindowExtMacOS as _;
        let _ = window;
        builder.build(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().expect("a GTK window has a box");
        let _ = proxy;
        builder.build_gtk(vbox)
    }
}

#[cfg(target_os = "macos")]
fn install_menu(proxy: EventLoopProxy<Ui>) -> Result<()> {
    use muda::{
        accelerator::Accelerator, AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem,
        Submenu,
    };
    let menu = Menu::new();
    let app = Submenu::new("Liquid Agent", true);
    app.append_items(&[
        &PredefinedMenuItem::about(
            None,
            Some(AboutMetadata {
                name: Some("Liquid Agent".into()),
                ..Default::default()
            }),
        ),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::hide(None),
        &PredefinedMenuItem::hide_others(None),
        &PredefinedMenuItem::show_all(None),
        &PredefinedMenuItem::separator(),
        &MenuItem::with_id(
            "quit",
            "Quit Liquid Agent",
            true,
            Some(Accelerator::new(
                Some(muda::accelerator::Modifiers::META),
                muda::accelerator::Code::KeyQ,
            )),
        ),
    ])?;
    let edit = Submenu::new("Edit", true);
    edit.append_items(&[
        &PredefinedMenuItem::undo(None),
        &PredefinedMenuItem::redo(None),
        &PredefinedMenuItem::separator(),
        &PredefinedMenuItem::cut(None),
        &PredefinedMenuItem::copy(None),
        &PredefinedMenuItem::paste(None),
        &PredefinedMenuItem::select_all(None),
    ])?;
    let view = Submenu::new("View", true);
    view.append(&MenuItem::with_id("reload", "Reload", true, None))?;
    let window_menu = Submenu::new("Window", true);
    window_menu.append_items(&[
        &PredefinedMenuItem::minimize(None),
        &PredefinedMenuItem::maximize(None),
    ])?;
    let help = Submenu::new("Help", true);
    help.append(&MenuItem::with_id(
        "website",
        "Liquid Agent Website",
        true,
        None,
    ))?;
    menu.append_items(&[&app, &edit, &view, &window_menu, &help])?;
    menu.init_for_nsapp();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let ui = match event.id.0.as_str() {
            "quit" => Ui::Quit,
            "reload" => Ui::Reload,
            "website" => Ui::Website,
            _ => return,
        };
        let _ = proxy.send_event(ui);
    }));
    Ok(())
}

fn stop_started_server() {
    if let Some(pid) = STARTED.lock().unwrap().take() {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
}

fn main() -> Result<()> {
    let data = data_dir();
    let Some(_lock) = single_instance(&data)? else {
        return Ok(());
    };
    let event_loop = EventLoopBuilder::<Ui>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    #[allow(unused_mut)]
    let mut builder = WindowBuilder::new()
        .with_title("Liquid Agent")
        .with_inner_size(LogicalSize::new(1280.0, 820.0))
        .with_min_inner_size(LogicalSize::new(760.0, 520.0));
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::WindowBuilderExtMacOS;
        // The look of the Mac app: the content runs under a transparent title bar.
        builder = builder
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true);
    }
    let window = builder
        .build(&event_loop)
        .context("Couldn't open the window.")?;
    let webview =
        build_webview(&window, proxy.clone()).context("Couldn't load the window's page.")?;
    #[cfg(target_os = "macos")]
    install_menu(proxy.clone())?;

    thread::spawn({
        let proxy = proxy.clone();
        move || open(proxy)
    });

    let mut webview = Some(webview);
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(ui) => match ui {
                Ui::Say(text) => {
                    if let Some(view) = &webview {
                        let _ = view.evaluate_script(&format!(
                            "window.say({})",
                            serde_json::Value::String(text)
                        ));
                    }
                }
                Ui::Failed(text) => {
                    if let Some(view) = &webview {
                        let _ = view.evaluate_script(&format!(
                            "window.failed({})",
                            serde_json::Value::String(text)
                        ));
                    }
                }
                Ui::Show(url) => {
                    if let Some(view) = &webview {
                        let _ = view.load_url(&url);
                    }
                }
                Ui::Drag => {
                    let _ = window.drag_window();
                }
                Ui::Reopen => window.set_visible(true),
                Ui::Reload => {
                    if let Some(view) = &webview {
                        let _ = view.evaluate_script("location.reload()");
                    }
                }
                Ui::Website => open_external(WEBSITE),
                Ui::Quit => {
                    stop_started_server();
                    webview.take();
                    *flow = ControlFlow::Exit;
                }
            },
            // Closing the window keeps the app running, like the Mac app it replaces.
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => window.set_visible(false),
            #[cfg(target_os = "macos")]
            Event::Reopen { .. } => window.set_visible(true),
            _ => {}
        }
    })
}
