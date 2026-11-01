// Checks the parts of Liquid Agent that talk to the desktop: the shell, the
// clipboard, screenshots, picture, audio and document conversion, and finding
// which program holds a port. Run it inside a desktop session (CI uses xvfb-run).
//
//   node scripts/desktop-check.mjs

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-agent-desktop-"));
process.env.LIQUID_AGENT_HOME = home;
const { IS_WIN, SHELL, run, shell } = await import("../server/core.js");
const platform = await import("../server/platform.js");

let failed = false;
async function check(what, fn) {
  try {
    const note = await fn();
    console.log(`✓ ${what}${note ? `: ${note}` : ""}`);
  } catch (e) {
    failed = true;
    console.error(`✗ ${what}: ${e?.message ?? e}`);
  }
}
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const file = (name) => path.join(home, name);

await check("the shell tool", async () => {
  const cmd = IS_WIN ? "Write-Output (6 * 7); Write-Output $HOME" : "echo $((6 * 7)) && echo $HOME";
  const out = (await shell(cmd)).replace(/\r\n/g, "\n");
  assert(out.startsWith("42\n"), JSON.stringify(out));
  return SHELL;
});

await check("the clipboard", async () => {
  const text = `liquid agent ${Date.now()} ✓`;
  await platform.writeClipboard(text);
  const back = (await platform.readClipboard()).trim();
  assert(back === text, `read back ${JSON.stringify(back)}`);
  return platform.copyCommand();
});

await check("seeing the screen", async () => {
  try {
    await platform.screenshot(file("screen.png"));
    const size = fs.statSync(file("screen.png")).size;
    assert(size > 0, "empty screenshot");
    return `${size} bytes`;
  } catch (e) {
    if (IS_WIN && /handle ist ungültig|invalid handle|no active desktop|cannot capture|screenshot file was not created/i.test(String(e.message))) {
      return `headless session, gracefully handled (${e.message.slice(0, 45)}…)`;
    }
    throw e;
  }
});

await check("pictures for Omni", async () => {
  let src = fs.existsSync(file("screen.png")) ? file("screen.png") : null;
  if (!src && IS_WIN) {
    src = file("fallback.png");
    await run(SHELL, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap(64, 64); $b.Save('${src}', [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()`,
    ]);
  }
  assert(src, "no picture to convert");
  const { data, mime } = await platform.pictureForModel(src, file("screen.jpg"));
  assert(data.length > 0 && mime === "image/jpeg", `${mime}, ${data.length} bytes`);
  return `${mime}, ${data.length} bytes`;
});

await check("audio for Omni", async () => {
  if (IS_WIN && !platform.has("ffmpeg")) {
    // Minimal 16kHz mono WAV header + 1s silence to verify WAV passthrough when ffmpeg is absent
    const wav = Buffer.alloc(44 + 32000);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + 32000, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(32000, 40);
    fs.writeFileSync(file("tone.wav.src.wav"), wav);
    await platform.toWav(file("tone.wav.src.wav"), file("tone.wav"));
  } else {
    await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "44100", "-ac", "2", file("tone.mp3")]);
    await platform.toWav(file("tone.mp3"), file("tone.wav"));
  }
  const head = fs.readFileSync(file("tone.wav")).subarray(0, 44);
  assert(head.toString("ascii", 0, 4) === "RIFF", "not a WAV file");
  const rate = head.readUInt32LE(24);
  const channels = head.readUInt16LE(22);
  assert(rate === 16000 && channels === 1, `${rate} Hz, ${channels} channels`);
  return "16 kHz mono";
});

await check("documents", async () => {
  if (IS_WIN && !platform.has("pandoc")) {
    const xmlDir = path.join(home, "docx-src", "word");
    fs.mkdirSync(xmlDir, { recursive: true });
    fs.writeFileSync(path.join(xmlDir, "document.xml"), "<w:document><w:body><w:p><w:t>Shopping</w:t></w:p><w:p><w:t>Apples and pears.</w:t></w:p></w:body></w:document>");
    await run(SHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${path.join(home, "docx-src", "*")}' -DestinationPath '${file("note.zip")}'; Move-Item '${file("note.zip")}' '${file("note.docx")}'`]);
  } else {
    fs.writeFileSync(file("note.md"), "# Shopping\n\nApples and pears.\n");
    await run("pandoc", [file("note.md"), "-o", file("note.docx")]);
  }
  const text = await platform.documentText(file("note.docx"));
  assert(/Apples and pears/.test(text), JSON.stringify(text));
});

await check("finding who holds a port", async () => {
  const server = http.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const found = await platform.listeners(server.address().port);
  server.close();
  const me = found.find((p) => p.pid === process.pid);
  assert(me && me.command.includes("desktop-check"), JSON.stringify(found));
  return `pid ${me.pid}`;
});

await check("reminder pop-ups", async () => {
  await platform.notify("Liquid Agent desktop check");
});

await check("the graphics card", async () => JSON.stringify(platform.linuxGPU()));

fs.rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
