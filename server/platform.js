// What differs between macOS and Linux: opening things, the clipboard,
// screenshots, notifications, converting pictures, audio and documents, which
// program holds a port, and which GPU the AI engine can use. On a Mac these
// use the tools macOS ships with. On Linux they use the common desktop tools
// when they're installed, and say which package to add when they aren't.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IS_MAC, run } from "./core.js";

const HOME = os.homedir();

const found = new Map();
/** True when a program is on the PATH. */
export function has(cmd) {
  if (!found.has(cmd)) {
    const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    found.set(
      cmd,
      dirs.some((dir) => {
        try {
          fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
    );
  }
  return found.get(cmd);
}

const wayland = () => Boolean(process.env.WAYLAND_DISPLAY);
const desktop = () => IS_MAC || Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
const desktopName = () => (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();

function missing(what, packages) {
  return new Error(`${what} on Linux needs ${packages}. Install it with your package manager (on Ubuntu: sudo apt install ${packages.split(" (")[0]}), then try again.`);
}

function noDesktop() {
  if (!desktop()) throw new Error("No desktop session is running here, so there's no screen, clipboard or apps to use.");
}

/** Starts a program that may keep running (a browser, an app) without waiting for it to quit. */
function launch(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 1500);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} couldn't open it (exit ${code}).`));
    });
  });
}

/** Feeds text to a program's stdin. Output is ignored: wl-copy and xclip leave a helper running that would hold pipes open. */
function pipeInto(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
    child.stdin.end(input);
  });
}

// ---- Opening things ----

/** Opens a web address or a file with the default app. */
export async function openPath(target) {
  if (IS_MAC) return run("open", [target]);
  noDesktop();
  if (has("xdg-open")) return launch("xdg-open", [target]);
  if (has("gio")) return launch("gio", ["open", target]);
  throw missing("Opening files and links", "xdg-utils");
}

/** Shows a folder in Finder or the file manager. */
export function reveal(dir) {
  return openPath(dir);
}

function desktopFiles() {
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(HOME, ".local", "share");
  const dataDirs = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const dirs = [
    path.join(dataHome, "applications"),
    ...dataDirs.map((d) => path.join(d, "applications")),
    path.join(dataHome, "flatpak", "exports", "share", "applications"),
    "/var/lib/flatpak/exports/share/applications",
    "/var/lib/snapd/desktop/applications",
  ];
  const files = [];
  for (const dir of new Set(dirs)) {
    try {
      for (const name of fs.readdirSync(dir)) if (name.endsWith(".desktop")) files.push(path.join(dir, name));
    } catch {}
  }
  return files;
}

/** Finds an installed app's .desktop file by its name ("Files", "firefox", "org.gnome.Nautilus"). */
function findApp(name) {
  const want = name.trim().toLowerCase().replace(/\.desktop$/, "");
  let close = null;
  for (const file of desktopFiles()) {
    const id = path.basename(file, ".desktop").toLowerCase();
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const entry = text.split(/^\[(?!Desktop Entry\])/m)[0];
    if (/^NoDisplay=true/m.test(entry) || /^Type=(?!Application)/m.test(entry)) continue;
    const title = entry.match(/^Name=(.*)$/m)?.[1]?.trim().toLowerCase() ?? "";
    if (id === want || id.endsWith(`.${want}`) || title === want) return { file, entry };
    if (!close && title.includes(want)) close = { file, entry };
  }
  return close;
}

/** Opens an app by name. */
export async function openApp(name) {
  if (IS_MAC) return run("open", ["-a", name]);
  noDesktop();
  const app = findApp(name);
  if (app) {
    const id = path.basename(app.file, ".desktop");
    if (has("gtk-launch")) return launch("gtk-launch", [id]);
    if (has("gio")) return launch("gio", ["launch", app.file]);
    const exec = app.entry.match(/^Exec=(.*)$/m)?.[1]?.replace(/\s%[a-zA-Z]/g, "").trim();
    if (exec) return launch("/bin/sh", ["-c", exec]);
  }
  const bin = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (/^[\w.+-]+$/.test(bin) && has(bin)) return launch(bin, []);
  throw new Error(`No app called “${name}” was found.`);
}

// ---- Clipboard ----

function clipboardTools() {
  const tools = [];
  if (wayland() && has("wl-paste") && has("wl-copy")) tools.push({ read: ["wl-paste", ["--no-newline"]], write: ["wl-copy", []] });
  if (process.env.DISPLAY && has("xclip")) tools.push({ read: ["xclip", ["-selection", "clipboard", "-o"]], write: ["xclip", ["-selection", "clipboard", "-in"]] });
  if (process.env.DISPLAY && has("xsel")) tools.push({ read: ["xsel", ["--clipboard", "--output"]], write: ["xsel", ["--clipboard", "--input"]] });
  return tools;
}

const NO_CLIPBOARD = () => missing("The clipboard", wayland() ? "wl-clipboard" : "xclip");

/** The command the safety helper is shown for a clipboard write. */
export const copyCommand = () => (IS_MAC ? "pbcopy" : (clipboardTools()[0]?.write ?? ["wl-copy"]).flat().join(" "));

export async function readClipboard() {
  if (IS_MAC) return run("pbpaste", []);
  noDesktop();
  const tool = clipboardTools()[0];
  if (!tool) throw NO_CLIPBOARD();
  try {
    return await run(...tool.read, { timeout: 10_000 });
  } catch (e) {
    if (/nothing is copied|no selection|target string not available/i.test(String(e.message))) return "";
    throw e;
  }
}

export async function writeClipboard(text) {
  if (IS_MAC) return pipeInto("pbcopy", [], text);
  noDesktop();
  const tool = clipboardTools()[0];
  if (!tool) throw NO_CLIPBOARD();
  return pipeInto(...tool.write, text);
}

// ---- Screenshots ----

/** Saves a PNG of the whole screen to `file`. */
export async function screenshot(file) {
  if (IS_MAC) return run("screencapture", ["-x", "-C", "-t", "png", file]);
  noDesktop();
  const de = desktopName();
  const tries = [];
  if (wayland()) {
    if (has("grim")) tries.push(["grim", [file]]); // sway, Hyprland and other wlroots desktops
    if (de.includes("kde") && has("spectacle")) tries.push(["spectacle", ["-b", "-n", "-f", "-o", file]]);
    if (de.includes("gnome") && has("gnome-screenshot")) tries.push(["gnome-screenshot", ["-f", file]]);
  } else {
    if (has("import")) tries.push(["import", ["-window", "root", file]]);
    if (has("scrot")) tries.push(["scrot", [file]]);
    if (has("maim")) tries.push(["maim", [file]]);
    if (has("gnome-screenshot")) tries.push(["gnome-screenshot", ["-f", file]]);
    if (has("spectacle")) tries.push(["spectacle", ["-b", "-n", "-f", "-o", file]]);
  }
  for (const [cmd, args] of tries) {
    try {
      await run(cmd, args, { timeout: 30_000 });
      if (fs.statSync(file).size > 0) return;
    } catch {}
  }
  // The desktop portal works on GNOME and KDE under Wayland. The desktop may ask the user first.
  if (has("gdbus")) return portalScreenshot(file);
  throw missing("Seeing the screen", wayland() ? "grim (or gnome-screenshot, or spectacle)" : "imagemagick (or scrot)");
}

function portalScreenshot(file) {
  const token = `liquid${crypto.randomBytes(5).toString("hex")}`;
  // The answer comes back as a D-Bus signal, so listen before asking.
  const monitor = spawn("gdbus", ["monitor", "--session", "--dest", "org.freedesktop.portal.Desktop"], { stdio: ["ignore", "pipe", "ignore"] });
  const done = new Promise((resolve, reject) => {
    let out = "";
    let asked = false;
    const timer = setTimeout(() => reject(new Error("The screenshot wasn't allowed in time.")), 60_000);
    const ask = () => {
      if (asked) return;
      asked = true;
      run("gdbus", [
        "call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop",
        "--method", "org.freedesktop.portal.Screenshot.Screenshot", "", `{'handle_token': <'${token}'>, 'interactive': <false>}`,
      ]).catch((e) => {
        clearTimeout(timer);
        reject(new Error(`This desktop can't take screenshots for apps (${e.message.slice(0, 120)}).`));
      });
    };
    setTimeout(ask, 1000);
    monitor.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    monitor.stdout.on("data", (d) => {
      out += d;
      if (/Monitoring/.test(out)) ask();
      const m = out.match(new RegExp(`/${token}: org\\.freedesktop\\.portal\\.Request\\.Response \\(uint32 (\\d+), (.*)\\)`));
      if (!m) return;
      clearTimeout(timer);
      const uri = m[2].match(/'uri': <'([^']+)'>/)?.[1];
      if (m[1] === "0" && uri) resolve(uri);
      else reject(new Error("The screenshot was cancelled or not allowed."));
    });
  });
  return done
    .then((uri) => {
      // The portal saves into the Pictures folder; move it out of the way.
      const saved = fileURLToPath(uri);
      fs.copyFileSync(saved, file);
      fs.rmSync(saved, { force: true });
    })
    .finally(() => monitor.kill());
}

// ---- Pictures, audio and documents ----

const RAW_PICTURE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp" };

/** Converts a picture to the format `dest` names (.png or .jpg), at most `max` pixels on its long side. */
export async function convertImage(src, dest, max = 1280) {
  if (IS_MAC) return run("sips", ["-s", "format", dest.endsWith(".png") ? "png" : "jpeg", "-Z", String(max), src, "--out", dest]);
  const tries = [];
  for (const im of ["magick", "convert"]) if (has(im)) tries.push([im, [`${src}[0]`, "-auto-orient", "-resize", `${max}x${max}>`, dest]]);
  if (has("ffmpeg")) {
    const fit = `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`;
    tries.push(["ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1", "-vf", fit, dest]]);
  }
  if (/\.heic$/i.test(src) && has("heif-convert")) tries.push(["heif-convert", [src, dest]]);
  let last;
  for (const [cmd, args] of tries) {
    try {
      return await run(cmd, args, { timeout: 60_000 });
    } catch (e) {
      last = e;
    }
  }
  throw last ?? missing("Opening this kind of picture", "imagemagick (or ffmpeg)");
}

/** A picture ready for Omni: a JPEG up to 1280 px, or the original when Linux has no converter and llama.cpp can read it as is. */
export async function pictureForModel(file, tmp) {
  try {
    await convertImage(file, tmp);
    return { data: fs.readFileSync(tmp), mime: "image/jpeg" };
  } catch (e) {
    const mime = RAW_PICTURE[path.extname(file).slice(1).toLowerCase()];
    if (IS_MAC || !mime) throw e;
    return { data: fs.readFileSync(file), mime };
  }
}

/** Converts audio to a 16 kHz mono WAV, the format Omni hears best. */
export async function toWav(src, dest) {
  if (IS_MAC) return run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dest]);
  if (has("ffmpeg")) return run("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dest], { timeout: 300_000 });
  // Omni takes WAV at any rate; it just hears 16 kHz mono best.
  if (/\.wav$/i.test(src)) return fs.copyFileSync(src, dest);
  throw missing("Listening to this audio", "ffmpeg");
}

/** Plain text from a Word, RTF or OpenDocument file. */
export function documentText(file) {
  if (IS_MAC) return run("textutil", ["-convert", "txt", "-stdout", file]);
  if (has("pandoc")) return run("pandoc", ["-t", "plain", "--wrap=none", file]);
  return Promise.reject(missing("Reading this kind of document", "pandoc"));
}

// ---- Notifications ----

export function notify(text) {
  if (IS_MAC) {
    return run("osascript", ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "Liquid Agent" sound name "Glass"', "-e", "end run", text]);
  }
  if (!desktop()) return Promise.resolve();
  if (has("notify-send")) return run("notify-send", ["-a", "Liquid Agent", "Liquid Agent", text]);
  if (has("gdbus")) {
    return run("gdbus", [
      "call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications",
      "--method", "org.freedesktop.Notifications.Notify", "Liquid Agent", "0", "", "Liquid Agent", JSON.stringify(text), "[]", "{}", "8000",
    ]);
  }
  return Promise.resolve();
}

// ---- Ports ----

/** Programs listening on a TCP port here, with their command lines. A pid of 0 means one we may not look at. */
export async function listeners(port) {
  if (IS_MAC || !fs.existsSync("/proc/net/tcp")) {
    let pids = [];
    try {
      pids = (await run("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"])).split("\n").filter(Boolean);
    } catch {
      return []; // lsof exits 1 when nothing listens
    }
    return Promise.all(pids.map(async (pid) => ({ pid: Number(pid), command: await run("ps", ["-o", "command=", "-p", pid]).catch(() => "") })));
  }
  const inodes = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(table, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      // f[1] is address:port in hex, f[3] the state (0A = listening), f[9] the socket's inode.
      if (f.length > 9 && f[3] === "0A" && parseInt(f[1].split(":").pop(), 16) === port) inodes.add(f[9]);
    }
  }
  const out = [];
  for (const pid of inodes.size ? fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)) : []) {
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // another user's process
    }
    for (const fd of fds) {
      let link = "";
      try {
        link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const inode = link.match(/^socket:\[(\d+)\]$/)?.[1];
      if (!inode || !inodes.has(inode)) continue;
      inodes.delete(inode);
      let command = "";
      try {
        command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
      } catch {}
      out.push({ pid: Number(pid), command });
      break;
    }
  }
  for (const _ of inodes) out.push({ pid: 0, command: "" });
  return out;
}

// ---- GPU ----

const VULKAN_LIBS = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib", "/lib/x86_64-linux-gnu", "/lib/aarch64-linux-gnu", "/lib64"];

function vulkanDrivers() {
  const dataDirs = (process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const dirs = new Set(["/etc/vulkan/icd.d", ...dataDirs.map((d) => path.join(d, "vulkan", "icd.d")), "/usr/share/vulkan/icd.d"]);
  const names = [];
  for (const dir of dirs) {
    try {
      names.push(...fs.readdirSync(dir).filter((n) => n.endsWith(".json")));
    } catch {}
  }
  // lavapipe is Vulkan drawn by the CPU, slower than llama.cpp's own CPU code.
  return names.filter((n) => !/lvp|lavapipe|swiftshader/i.test(n));
}

/** What the AI engine could use on this Linux computer. */
export function linuxGPU() {
  let nvidiaDriver = null;
  try {
    const v = fs.readFileSync("/proc/driver/nvidia/version", "utf8").match(/Kernel Module\s+(?:for \S+\s+)?(\d+)\./);
    if (v) nvidiaDriver = Number(v[1]);
  } catch {}
  let devices = nvidiaDriver !== null;
  try {
    devices ||= fs.readdirSync("/dev/dri").some((n) => n.startsWith("renderD"));
  } catch {}
  const loader = VULKAN_LIBS.some((dir) => fs.existsSync(path.join(dir, "libvulkan.so.1")));
  return { vulkan: devices && loader && vulkanDrivers().length > 0, nvidiaDriver };
}
