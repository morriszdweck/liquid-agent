//! Local image, screenshot, and audio-file tools for Omni.
use crate::{media, platform, store, App};
use anyhow::{bail, Context, Result};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;

const LIMIT: u64 = 25 * 1024 * 1024;
pub(crate) struct Scratch(PathBuf);
impl Scratch {
    pub(crate) fn new() -> Result<Self> {
        let path = std::env::temp_dir().join(format!("liquid-agent-{}", store::id()));
        std::fs::create_dir(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self(path))
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn run(
    program: &str,
    args: &[String],
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<()> {
    anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("Could not start {program}"))?;
    let status = tokio::select! {_=cancel.cancelled()=>{let _=child.kill().await;bail!("Stopped.")},result=tokio::time::timeout(timeout,child.wait())=>result.context("Media operation timed out")??};
    anyhow::ensure!(status.success(), "{program} failed.");
    Ok(())
}
async fn read_file(file: &Path) -> Result<Vec<u8>> {
    let input = tokio::fs::File::open(file).await?;
    anyhow::ensure!(input.metadata().await?.is_file(), "Not a file.");
    let mut bytes = Vec::new();
    input.take(LIMIT + 1).read_to_end(&mut bytes).await?;
    anyhow::ensure!(bytes.len() as u64 <= LIMIT, "Media file is too large.");
    Ok(bytes)
}
pub(crate) async fn image(
    file: &Path,
    scratch: &Scratch,
    cancel: &CancellationToken,
) -> Result<(Vec<u8>, &'static str)> {
    let _ = read_file(file).await?;
    let src = file.to_string_lossy().to_string();
    let dest = scratch.file("converted.jpg");
    let out = dest.to_string_lossy().to_string();
    let mut tries = Vec::new();
    if cfg!(target_os = "macos") {
        tries.push((
            "sips",
            vec![
                "-s".into(),
                "format".into(),
                "jpeg".into(),
                "-Z".into(),
                "1280".into(),
                src.clone(),
                "--out".into(),
                out.clone(),
            ],
        ));
    } else {
        for command in ["magick", "convert"] {
            if platform::has(command) {
                tries.push((
                    command,
                    vec![
                        format!("{src}[0]"),
                        "-auto-orient".into(),
                        "-resize".into(),
                        "1280x1280>".into(),
                        out.clone(),
                    ],
                ));
            }
        }
        if platform::has("ffmpeg") {
            tries.push((
                "ffmpeg",
                vec![
                    "-nostdin".into(),
                    "-loglevel".into(),
                    "error".into(),
                    "-y".into(),
                    "-i".into(),
                    src.clone(),
                    "-frames:v".into(),
                    "1".into(),
                    "-vf".into(),
                    "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease"
                        .into(),
                    out.clone(),
                ],
            ));
        }
        if file
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("heic"))
            && platform::has("heif-convert")
        {
            tries.push(("heif-convert", vec![src.clone(), out.clone()]));
        }
    }
    for (program, args) in tries {
        if run(program, &args, Duration::from_secs(60), cancel)
            .await
            .is_ok()
        {
            if let Ok(data) = read_file(&dest).await {
                if !data.is_empty() {
                    return Ok((data, "image/jpeg"));
                }
            }
        }
        anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    }
    let mime = match file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => bail!("Opening this kind of picture needs an image converter."),
    };
    Ok((read_file(file).await?, mime))
}
pub(crate) async fn audio(
    file: &Path,
    scratch: &Scratch,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    let _ = read_file(file).await?;
    let wav = file
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("wav"));
    let src = file.to_string_lossy().to_string();
    let dest = scratch.file("audio.wav");
    let out = dest.to_string_lossy().to_string();
    let attempt = if cfg!(target_os = "macos") {
        Some((
            "afconvert",
            vec![
                "-f".into(),
                "WAVE".into(),
                "-d".into(),
                "LEI16@16000".into(),
                "-c".into(),
                "1".into(),
                src.clone(),
                out,
            ],
        ))
    } else if platform::has("ffmpeg") {
        Some((
            "ffmpeg",
            vec![
                "-nostdin".into(),
                "-loglevel".into(),
                "error".into(),
                "-y".into(),
                "-i".into(),
                src.clone(),
                "-ac".into(),
                "1".into(),
                "-ar".into(),
                "16000".into(),
                "-c:a".into(),
                "pcm_s16le".into(),
                out,
            ],
        ))
    } else {
        None
    };
    if let Some((program, args)) = attempt {
        if run(program, &args, Duration::from_secs(300), cancel)
            .await
            .is_ok()
        {
            return read_file(&dest).await;
        }
        anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    }
    if wav {
        return read_file(file).await;
    }
    bail!("Listening to this audio needs ffmpeg or afconvert.")
}
async fn portal(dest: &Path, cancel: &CancellationToken) -> Result<()> {
    let token = format!("liquid{}", store::id().replace('-', ""));
    let mut monitor = tokio::process::Command::new("gdbus")
        .args([
            "monitor",
            "--session",
            "--dest",
            "org.freedesktop.portal.Desktop",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = monitor
        .stdout
        .take()
        .context("Could not monitor screenshot portal")?;
    let mut lines = BufReader::new(stdout).lines();
    let work = async {
        // Wait until the monitor is listening; older gdbus versions may be quiet.
        let _ = tokio::time::timeout(Duration::from_secs(1), lines.next_line()).await;
        run(
            "gdbus",
            &[
                "call".into(),
                "--session".into(),
                "--dest".into(),
                "org.freedesktop.portal.Desktop".into(),
                "--object-path".into(),
                "/org/freedesktop/portal/desktop".into(),
                "--method".into(),
                "org.freedesktop.portal.Screenshot.Screenshot".into(),
                "".into(),
                format!("{{'handle_token': <'{token}'>, 'interactive': <false>}}"),
            ],
            Duration::from_secs(10),
            cancel,
        )
        .await?;
        let response = regex::Regex::new(r"uint32\s+(\d+)").unwrap();
        let uri = regex::Regex::new(r"'uri':\s*<'([^']+)'>").unwrap();
        while let Some(line) = lines.next_line().await? {
            if !line.contains(&format!("/{token}:")) {
                continue;
            }
            let status = response
                .captures(&line)
                .and_then(|c| c[1].parse::<u32>().ok())
                .context("Invalid screenshot response")?;
            anyhow::ensure!(status == 0, "The screenshot was cancelled or not allowed.");
            let uri = uri
                .captures(&line)
                .context("Screenshot portal returned no file")?[1]
                .to_owned();
            let path = url::Url::parse(&uri)?
                .to_file_path()
                .map_err(|_| anyhow::anyhow!("Invalid screenshot path"))?;
            let data = read_file(&path).await?;
            tokio::fs::write(dest, data).await?;
            return Ok(());
        }
        bail!("Screenshot portal closed.")
    };
    let result = tokio::select! {_ = cancel.cancelled()=>Err(anyhow::anyhow!("Stopped.")),r=tokio::time::timeout(Duration::from_secs(60),work)=>r.context("The screenshot wasn't allowed in time")?};
    let _ = monitor.kill().await;
    result
}
/// One picture of the whole screen, as PNG bytes, for "look at my screen" (the user asked for it in the app).
pub async fn capture_screen(cancel: &CancellationToken) -> Result<Vec<u8>> {
    let scratch = Scratch::new()?;
    let shot = scratch.file("screen.png");
    screenshot(&shot, cancel).await?;
    read_file(&shot).await
}

pub(crate) async fn screenshot(dest: &Path, cancel: &CancellationToken) -> Result<()> {
    platform::desktop()?;
    let out = dest.to_string_lossy().to_string();
    let mut tries = Vec::new();
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase();
    if cfg!(target_os = "macos") {
        tries.push((
            "screencapture",
            vec![
                "-x".into(),
                "-C".into(),
                "-t".into(),
                "png".into(),
                out.clone(),
            ],
        ));
    } else if wayland {
        if platform::has("grim") {
            tries.push(("grim", vec![out.clone()]));
        }
        if desktop.contains("kde") && platform::has("spectacle") {
            tries.push((
                "spectacle",
                vec![
                    "-b".into(),
                    "-n".into(),
                    "-f".into(),
                    "-o".into(),
                    out.clone(),
                ],
            ));
        }
        if desktop.contains("gnome") && platform::has("gnome-screenshot") {
            tries.push(("gnome-screenshot", vec!["-f".into(), out.clone()]));
        }
    } else {
        for (cmd, args) in [
            ("import", vec!["-window".into(), "root".into(), out.clone()]),
            ("scrot", vec![out.clone()]),
            ("maim", vec![out.clone()]),
            ("gnome-screenshot", vec!["-f".into(), out.clone()]),
            (
                "spectacle",
                vec![
                    "-b".into(),
                    "-n".into(),
                    "-f".into(),
                    "-o".into(),
                    out.clone(),
                ],
            ),
        ] {
            if platform::has(cmd) {
                tries.push((cmd, args));
            }
        }
    }
    for (program, args) in tries {
        if run(program, &args, Duration::from_secs(30), cancel)
            .await
            .is_ok()
            && tokio::fs::metadata(dest).await.is_ok_and(|m| m.len() > 0)
        {
            return Ok(());
        }
        anyhow::ensure!(!cancel.is_cancelled(), "Stopped.");
    }
    if !cfg!(target_os = "macos") && platform::has("gdbus") {
        return portal(dest, cancel).await;
    }
    bail!("Seeing the screen requires a screenshot utility.")
}
pub async fn execute(
    app: &App,
    name: &str,
    file: &Path,
    question: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    anyhow::ensure!(
        app.backends.running("omni"),
        "This tool needs Eyes and ears. Set it up in Settings → Downloads."
    );
    let settings = app.settings.lock().unwrap().clone();
    let url = media::local_url(&settings)
        .context("Refusing a model address that isn't on this computer")?
        .to_string();
    let scratch = Scratch::new()?;
    let result = match name {
        "transcribe_audio" => {
            let bytes = audio(file, &scratch, cancel).await?;
            tokio::select! {_=cancel.cancelled()=>bail!("Stopped."),r=media::completion(&url,&bytes)=>r?}
        }
        "look_at_screen" | "look_at_image" => {
            let path = if name == "look_at_screen" {
                let path = scratch.file("screen.png");
                screenshot(&path, cancel).await?;
                path
            } else {
                file.to_path_buf()
            };
            let (bytes, mime) = image(&path, &scratch, cancel).await?;
            let question = if question.trim().is_empty() {
                if name == "look_at_screen" {
                    "Describe what is on this screen."
                } else {
                    "Describe this picture."
                }
            } else {
                question
            };
            tokio::select! {_=cancel.cancelled()=>bail!("Stopped."),r=media::vision(&url,&bytes,mime,question)=>r?}
        }
        _ => bail!("Unknown media tool."),
    };
    Ok(result)
}
