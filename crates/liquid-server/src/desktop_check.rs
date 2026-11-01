//! Checks the parts of Liquid Agent that talk to the desktop: the clipboard,
//! screenshots, pictures and audio for the model, document conversion, finding
//! which program holds a port, reminder pop-ups and the graphics card. They need
//! a desktop session, so they are ignored by default. Run them with:
//!
//!   cargo test -p liquid-server desktop_check -- --ignored --nocapture --test-threads=1
//!
//! CI runs them under xvfb, with pandoc, ffmpeg, xclip and libnotify installed.
#![cfg(test)]

use crate::{backends, platform, scheduler, store, uploads, vision_tools};
use std::{net::TcpListener, path::PathBuf};
use tokio_util::sync::CancellationToken;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("liquid-desktop-{name}-{}", store::id()));
    std::fs::create_dir_all(&dir).expect("scratch folder");
    dir
}

#[tokio::test]
#[ignore = "needs a desktop session"]
async fn clipboard_round_trips() {
    let cancel = CancellationToken::new();
    let text = format!("liquid agent {} ✓", store::id());
    platform::write_clipboard(&text, &cancel)
        .await
        .expect("write the clipboard");
    let back = platform::read_clipboard(&cancel)
        .await
        .expect("read the clipboard");
    assert_eq!(back.trim(), text);
}

#[tokio::test]
#[ignore = "needs a desktop session"]
async fn screenshot_and_picture_for_the_model() {
    let cancel = CancellationToken::new();
    let dir = scratch("screen");
    let shot = dir.join("screen.png");
    vision_tools::screenshot(&shot, &cancel)
        .await
        .expect("take a screenshot");
    assert!(std::fs::metadata(&shot).expect("screenshot").len() > 0);
    let work = vision_tools::Scratch::new().expect("scratch");
    let (data, mime) = vision_tools::image(&shot, &work, &cancel)
        .await
        .expect("convert the picture for the model");
    assert_eq!(mime, "image/jpeg");
    assert!(!data.is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore = "needs ffmpeg"]
async fn audio_for_the_model_is_16khz_mono_wav() {
    let cancel = CancellationToken::new();
    let dir = scratch("audio");
    let tone = dir.join("tone.mp3");
    let made = std::process::Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-ar",
            "44100",
            "-ac",
            "2",
        ])
        .arg(&tone)
        .status()
        .expect("run ffmpeg");
    assert!(made.success());
    let work = vision_tools::Scratch::new().expect("scratch");
    let wav = vision_tools::audio(&tone, &work, &cancel)
        .await
        .expect("convert the audio");
    assert_eq!(&wav[0..4], b"RIFF");
    let channels = u16::from_le_bytes([wav[22], wav[23]]);
    let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
    assert_eq!((rate, channels), (16000, 1));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore = "needs pandoc"]
async fn documents_become_text_for_the_model() {
    let dir = scratch("documents");
    std::fs::write(dir.join("note.md"), "# Shopping\n\nApples and pears.\n").expect("note");
    let made = std::process::Command::new("pandoc")
        .arg(dir.join("note.md"))
        .arg("-o")
        .arg(dir.join("note.docx"))
        .status()
        .expect("run pandoc");
    assert!(made.success());
    let bytes = std::fs::read(dir.join("note.docx")).expect("docx");
    let record = uploads::prepare(
        &dir,
        "note.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        &bytes,
    )
    .await
    .expect("accept the document");
    let text = uploads::text_for(&dir, &record, 10_000).expect("document text");
    assert!(text.contains("Apples and pears"), "{text}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
#[ignore = "needs a desktop session"]
fn finding_who_holds_a_port() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
    let port = listener.local_addr().expect("address").port();
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let found = runtime.block_on(platform::listeners(port));
    let me = found
        .iter()
        .find(|(pid, _)| *pid == std::process::id())
        .expect("this test process holds the port");
    assert!(!me.1.is_empty());
}

#[tokio::test]
#[ignore = "needs a desktop session"]
async fn reminder_pop_ups_and_graphics_card() {
    scheduler::desktop_notify("Liquid Agent desktop check");
    // The pop-up is sent in the background; give it time to start.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    println!(
        "{}",
        liquid_core::i18n::diag_language()
            .graphics_card
            .replace("{gpu}", &backends::gpu_flavor().to_string())
    );
}
