// Shared plumbing: where things live, JSON storage, settings, the event bus
// and child-process helpers.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Paths ----

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();

export const IS_MAC = process.platform === "darwin";
/** How prompts and messages name this computer. */
export const DEVICE = IS_MAC ? "Mac" : "computer";

export const DATA =
  process.env.LIQUID_AGENT_HOME ??
  (process.platform === "darwin"
    ? path.join(HOME, "Library", "Application Support", "LiquidAgent")
    : path.join(process.env.XDG_DATA_HOME ?? path.join(HOME, ".local", "share"), "liquid-agent"));

export const DIRS = {
  models: path.join(DATA, "models"),
  engine: path.join(DATA, "engine"),
  tools: path.join(DATA, "tools"),
  logs: path.join(DATA, "logs"),
  uploads: path.join(DATA, "uploads"),
  guardian: path.join(DATA, "guardian"),
  bridge: path.join(DATA, "bridge"),
  hf: path.join(DATA, "hf"),
};
for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });

// ---- JSON storage ----

export function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), "utf8"));
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  const file = path.join(DATA, name);
  fs.writeFileSync(file + ".tmp", JSON.stringify(value));
  fs.renameSync(file + ".tmp", file);
}

const pending = new Set();

/** Debounced save, so streaming tokens don't hit the disk on every delta. */
export function saver(name, get, ms = 400) {
  let timer;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    pending.delete(flush);
    save(name, get());
  };
  const schedule = () => {
    pending.add(flush);
    timer ??= setTimeout(flush, ms);
  };
  schedule.flush = flush;
  return schedule;
}

export function flushAll() {
  for (const flush of [...pending]) flush();
}

// ---- Settings ----

export const PERSONALITIES = {
  friendly: "Be warm, clear and patient. Explain simply.",
  concise: "Be extremely brief. No filler.",
  playful: "Be witty and fun, but still helpful.",
  professional: "Be precise and professional.",
};

export const DEFAULTS = {
  userName: "",
  personality: "friendly",
  approvalMode: "askAlways", // askAlways | approveForMe (needs Auto 200M) | fullAuto
  theme: "system",
  voice: "female",
  speakReplies: false,
  autoUpdate: true,
  workspace: HOME,
  guardianThreshold: 0.5,
  contextBudget: 6000,
  toolOutputLimit: 1200,
  maxSteps: 8,
  temperature: 0.3,
  smallQuant: "Q4_K_M",
  omniQuant: "Q4_K_M",
  smallURL: "http://127.0.0.1:8180/v1",
  omniURL: "http://127.0.0.1:8181/v1",
  guardianURL: "http://127.0.0.1:8766",
  browserURL: "http://127.0.0.1:8767",
};

const URL_KEYS = new Set(["smallURL", "omniURL", "guardianURL", "browserURL"]);
/** Download sizes offered for each model, smallest first. Sizes are bytes on Hugging Face. */
export const QUANTS = {
  small: [
    { id: "QAD-Q4_0", label: "Smallest", bytes: 1.05e9, note: "Trained to stay sharp at 4-bit" },
    { id: "Q4_K_M", label: "Balanced", bytes: 1.1e9, note: "Recommended" },
    { id: "Q5_K_M", label: "Sharper", bytes: 1.26e9 },
    { id: "Q6_K", label: "Sharper still", bytes: 1.43e9 },
    { id: "Q8_0", label: "Best", bytes: 1.85e9, note: "Near full quality" },
    { id: "F16", label: "Full quality", bytes: 3.47e9, note: "Slowest, needs the most memory" },
  ],
  omni: [
    { id: "Q4_0", label: "Smallest", bytes: 1.05e9 },
    { id: "Q4_K_M", label: "Balanced", bytes: 1.1e9, note: "Recommended" },
    { id: "Q8_0", label: "Best", bytes: 1.85e9, note: "Near full quality" },
    { id: "F16", label: "Full quality", bytes: 3.47e9, note: "Slowest, needs the most memory" },
  ],
};

const CHOICES = {
  smallQuant: QUANTS.small.map((q) => q.id),
  omniQuant: QUANTS.omni.map((q) => q.id),
  personality: Object.keys(PERSONALITIES),
  approvalMode: ["askAlways", "approveForMe", "fullAuto"],
  theme: ["system", "light", "dark"],
  voice: ["female", "male"],
};

export const settings = { ...DEFAULTS, ...load("settings.json", {}) };

/** Applies only known keys of the right type. Every endpoint must stay on this machine. */
export function updateSettings(patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) continue;
    if (URL_KEYS.has(key) && !isLocal(value)) continue;
    if (CHOICES[key] && !CHOICES[key].includes(value)) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    settings[key] = value;
  }
  save("settings.json", settings);
  bus.emit("settings", { settings });
  return settings;
}

export function isLocal(url) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export const MODELS = {
  small: { id: "LFM3-1.7B", label: "LFM3 1.7B", url: () => settings.smallURL, temperature: () => settings.temperature },
  omni: { id: "LFM3-Omni-2B", label: "LFM3 Omni 2B", url: () => settings.omniURL, temperature: () => 0 },
};

// ---- Event bus (server -> every open tab) ----

const clients = new Set();

export const bus = {
  add(ws) {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
  },
  emit(type, data = {}) {
    const message = JSON.stringify({ type, ...data });
    for (const ws of clients) if (ws.readyState === 1) ws.send(message);
  },
  get listeners() {
    return clients.size;
  },
};

// ---- Processes ----

const MAX_OUTPUT = 200_000;

/** Runs a program; resolves with its output, rejects on a non-zero exit. */
export function run(cmd, args, { cwd, env, timeout = 600_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, signal });
    let out = "";
    const add = (d) => {
      if (out.length < MAX_OUTPUT) out += d;
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${out.trim().slice(-500)}`));
    });
  });
}

/** The shell tool's shell: zsh on macOS; on Linux the user's own bash or zsh, else bash, else sh. */
export const SHELL = (() => {
  if (IS_MAC) return "/bin/zsh";
  const own = process.env.SHELL ?? "";
  for (const candidate of [/\/(bash|zsh)$/.test(own) ? own : "", "/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
    try {
      if (candidate) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {}
  }
  return "/bin/sh";
})();

/** Shell command for the shell tool. Never throws: failures come back as text the model can read. */
export function shell(command, { cwd, timeout = 60_000, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(SHELL, [path.basename(SHELL) === "sh" ? "-c" : "-lc", command], { cwd, signal });
    let out = "";
    const add = (d) => {
      if (out.length < MAX_OUTPUT) out += d;
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      out += `\n[timed out after ${timeout / 1000}s]`;
      child.kill("SIGTERM");
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`error: ${e.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : `exit ${code}\n${out}`);
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bytesText(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
