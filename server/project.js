// A chat can be tied to one project folder. The agent then works only there:
// file tools refuse paths outside it, and shell commands run in a sandbox that
// can write only inside the folder and can't read the rest of your home folder
// (sandbox-exec on macOS, bubblewrap on Linux).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_MAC, load, save } from "./core.js";
import { has } from "./platform.js";

const HOME = os.homedir();
const tilde = (f) => (f.startsWith(HOME) ? "~" + f.slice(HOME.length) : f);

/** Real path of a file that may not exist yet: resolves symlinks in the part that does. */
function real(file) {
  const rest = [];
  let cur = path.resolve(file);
  for (;;) {
    try {
      fs.lstatSync(cur);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

/** Checks a folder can be a project and returns its real path. */
export function projectFolder(dir) {
  const raw = String(dir ?? "").trim();
  if (!raw) throw new Error("Choose a folder.");
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(HOME, raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) throw new Error("Use the full path of the folder.");
  let root;
  try {
    root = fs.realpathSync(expanded);
  } catch {
    throw new Error(`${raw} doesn't exist.`);
  }
  if (!fs.statSync(root).isDirectory()) throw new Error(`${tilde(root)} isn't a folder.`);
  if (root === path.parse(root).root || root === fs.realpathSync(HOME)) throw new Error("Pick a smaller folder than that, like one project.");
  return root;
}

/** True when a path is the project folder or inside it, after following symlinks. */
export function inside(root, file) {
  let r;
  try {
    r = real(file);
  } catch {
    return false;
  }
  return r === root || r.startsWith(root + path.sep);
}

/** Throws when a tool would reach outside the project folder. */
export function guard(root, file) {
  if (root && !inside(root, file)) throw new Error(`${tilde(file)} is outside the project folder (${tilde(root)}). I can only work inside it.`);
  return file;
}

// ---- Recent projects ----

let recent = load("projects.json", []);

export const recentProjects = () => recent.filter((p) => fs.existsSync(p));

export function remember(root) {
  recent = [root, ...recent.filter((p) => p !== root)].slice(0, 8);
  save("projects.json", recent);
}

export function forget(root) {
  recent = recent.filter((p) => p !== root);
  save("projects.json", recent);
}

// ---- Folder picker ----

/** Opens the system's folder picker. Returns the folder, null if cancelled, or throws if there's no picker. */
export function pickFolder() {
  let cmd;
  let args;
  if (IS_MAC) {
    cmd = "osascript";
    args = ["-e", "activate", "-e", 'POSIX path of (choose folder with prompt "Choose a project folder for Liquid Agent")'];
  } else if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && has("zenity")) {
    cmd = "zenity";
    args = ["--file-selection", "--directory", "--title=Choose a project folder"];
  } else if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && has("kdialog")) {
    cmd = "kdialog";
    args = ["--getexistingdirectory", HOME, "--title", "Choose a project folder"];
  } else {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim().replace(/(.)\/$/, "$1") : null));
  });
}

/** Subfolders of a folder, for the in-app picker when there's no system one. */
export function listFolders(dir) {
  const raw = String(dir || "~");
  const base = path.resolve(raw === "~" || raw.startsWith("~/") ? path.join(HOME, raw.slice(1)) : raw);
  const folders = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(base, e.name)))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return { path: base, display: tilde(base), parent: path.dirname(base) === base ? null : path.dirname(base), folders };
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---- Shell sandbox ----

/** Where developer tools live in a home folder. The sandbox may read these so commands like cargo or nvm work. */
const TOOL_DIRS = [".local/bin", ".cargo", ".rustup", ".bun", ".deno", ".nvm", ".pyenv", ".volta", ".sdkman", ".oh-my-zsh", ".config/git"];

const quote = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** macOS sandbox profile: write only in the project and temp folders, read nothing else in home. */
function macProfile(root) {
  const home = fs.realpathSync(HOME);
  const caches = ["Library/Caches", ".cache", ".npm"].map((d) => `(subpath ${quote(path.join(home, d))})`).join(" ");
  const dotfile = `(regex ${quote(`^${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.[^/]+$`)})`;
  const tools = TOOL_DIRS.map((d) => `(subpath ${quote(path.join(home, d))})`).join(" ");
  return `(version 1)
(allow default)
(deny file-read* (subpath ${quote(home)}) (subpath "/Volumes"))
(allow file-read-metadata)
(allow file-read* (subpath ${quote(root)}) ${dotfile} ${caches} ${tools})
(deny file-write*)
(allow file-write* (subpath ${quote(root)}) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev") ${caches})
(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/sudo"))
(deny appleevent-send)
`;
}

/** Linux: bubblewrap with the system read-only, home hidden and only the project writable. */
function linuxArgs(root) {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", HOME];
  for (const dir of TOOL_DIRS) {
    const p = path.join(HOME, dir);
    if (fs.existsSync(p) && !inside(root, p)) args.push("--ro-bind", p, p);
  }
  for (const m of ["/media", "/mnt", "/run/media"]) if (fs.existsSync(m) && !root.startsWith(m + "/")) args.push("--tmpfs", m);
  args.push("--bind", root, root, "--chdir", root, "--die-with-parent", "--unshare-pid", "--new-session");
  return args;
}

let bwrapWorks;
function canBwrap() {
  if (bwrapWorks === undefined) {
    bwrapWorks = has("bwrap") && spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], { timeout: 5000 }).status === 0;
  }
  return bwrapWorks;
}

/** How shell commands are kept inside the project on this computer, or null if they can't be. */
export function sandboxKind() {
  if (IS_MAC) return fs.existsSync("/usr/bin/sandbox-exec") ? "sandbox-exec" : null;
  return canBwrap() ? "bubblewrap" : null;
}

/** The program and arguments that run a shell command inside the project, or null without a sandbox. */
export function sandboxed(root, shellPath, command) {
  const flag = path.basename(shellPath) === "sh" ? "-c" : "-lc";
  if (IS_MAC && sandboxKind()) return { cmd: "/usr/bin/sandbox-exec", args: ["-p", macProfile(root), shellPath, flag, command] };
  if (!IS_MAC && sandboxKind()) return { cmd: "bwrap", args: [...linuxArgs(root), shellPath, flag, command] };
  return null;
}

/**
 * Without a sandbox, a best-effort check: refuse commands that name a place
 * outside the project: absolute paths, ~, climbing out with .., or a symlink
 * inside the project that leads out. The agent also asks before every command.
 */
export function reachesOut(root, command) {
  const words = String(command).match(/[^\s'";|&<>()=`$]+/g) ?? [];
  for (const word of words) {
    if (/^-/.test(word) || /^\/dev\/(null|stdout|stderr|tty)$/.test(word) || /^\/(tmp|usr|bin|sbin|etc|opt|proc)(\/|$)/.test(word)) continue;
    const named = /^(~|\.\.|\/)/.test(word);
    const abs = word.startsWith("~") ? path.join(HOME, word.slice(1)) : path.resolve(root, word);
    // A plain word only counts when it's something on disk, such as a symlink in the project.
    if (!named && !lexists(path.resolve(root, word.split("/")[0]))) continue;
    if (!inside(root, abs)) return word;
  }
  return null;
}

function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
