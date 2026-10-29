// Downloads, installs and runs every local part. Downloads come from Hugging
// Face and GitHub once; after that every part runs here on 127.0.0.1.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DATA, DIRS, QUANTS, ROOT, bus, bytesText, load, run, save, settings, sleep } from "./core.js";

export const PARTS = {
  engine: {
    title: "AI engine",
    detail: "Runs the models on your Mac (latest llama.cpp).",
    size: "about 30 MB",
    bytes: 0.03e9,
  },
  small: {
    title: "Everyday brain",
    detail: "LFM3 1.7B. Fast chat, writing and actions.",
    size: "1.1 GB",
    port: 8180,
  },
  omni: {
    title: "Eyes and ears",
    detail: "LFM3 Omni 2B. Voice chat, pictures, your screen and audio.",
    size: "1.6 GB",
    port: 8181,
  },
  guardian: {
    title: "Safety helper",
    detail: "Auto 200M (INT4). Checks each action is safe before it runs.",
    size: "about 900 MB",
    bytes: 0.9e9,
    port: 8766,
  },
  browser: {
    title: "Web helper",
    detail: "Betterwright. Lets the agent click around websites for you.",
    size: "about 250 MB",
    bytes: 0.25e9,
    port: 8767,
  },
};
export const ORDER = ["engine", "small", "omni", "guardian", "browser"];

// Each model comes in several sizes (quants); settings pick which one is used.
const GGUF = {
  small: { repo: "LiquidAI/LFM3-1.7B-GGUF", prefix: "LFM3-1.7B-" },
  omni: { repo: "LiquidAI/LFM3-Omni-2B-GGUF", prefix: "LFM3-Omni-2B-" },
};
const OMNI_PROJECTOR = { file: "mmproj-LFM3-Omni-2B-Q8_0.gguf", bytes: 0.54e9 };
const quantOf = (id) => QUANTS[id].find((q) => q.id === settings[`${id}Quant`]) ?? QUANTS[id][1];
const weightsFile = (id) => `${GGUF[id].prefix}${quantOf(id).id}.gguf`;

const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ENGINE_ASSET = process.platform === "darwin" ? `bin-macos-${ARCH}.tar.gz` : `bin-ubuntu-${ARCH}.tar.gz`;

const model = (name) => path.join(DIRS.models, name);
const weights = (id) => model(weightsFile(id));
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const marker = (dir) => path.join(dir, ".ready");

/** Finds the llama-server inside the app's own engine folder. */
function findEngine() {
  const stack = [DIRS.engine];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "llama-server") return full;
    }
  }
  return null;
}

/** Streams a file to disk with progress, resuming a partial download when the server allows it. */
async function download(url, dest, { onProgress, signal } = {}) {
  const part = dest + ".part";
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, { signal, headers: start ? { Range: `bytes=${start}-` } : {} });
  if (res.status === 416) {
    fs.renameSync(part, dest);
    return;
  }
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}). Check your internet and try again.`);
  if (res.status !== 206) start = 0;
  const total = start + (Number(res.headers.get("content-length")) || 0);
  const file = fs.createWriteStream(part, { flags: start ? "a" : "w" });
  let done = start;
  let last = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!file.write(chunk)) await new Promise((r) => file.once("drain", r));
      if (Date.now() - last > 250) {
        last = Date.now();
        onProgress?.(done, total);
      }
    }
    await new Promise((resolve, reject) => file.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    file.destroy();
    throw e;
  }
  onProgress?.(done, total);
  fs.renameSync(part, dest);
}

class Backends {
  states = {};
  procs = {};
  busy = false;
  controller = null;
  /** Parts asked for while another download was running. They go next. */
  queued = new Set();
  /** Parts the current download run still has to get to. */
  plan = new Set();
  current = null;
  /** Parts between "start" and having a process, so two starts can't race. */
  launching = new Set();
  /** Approve for Me was picked before Auto 200M was ready; it turns on once Auto 200M runs. */
  guardianWanted = false;
  /** Called with a part's id each time it becomes ready. */
  readyHooks = [];

  constructor() {
    this.refresh();
    for (const id of ORDER) if (this.states[id].status === "installing") this.states[id] = { status: "missing" };
    const saved = load("downloads.json", {});
    this.unfinished = Array.isArray(saved.pending) ? saved.pending.filter((id) => ORDER.includes(id)) : [];
    this.guardianWanted = saved.approveForMe === true;
  }

  /** Downloads and the Approve for Me wish survive a restart; they pick up where they stopped. */
  remember() {
    const pending = [...new Set([this.current, ...this.plan, ...this.queued].filter(Boolean))];
    save("downloads.json", { pending, approveForMe: this.guardianWanted });
  }

  /** Called once at startup: continues downloads a restart interrupted. */
  resume() {
    if (this.unfinished.length) this.install(this.unfinished);
    this.unfinished = [];
  }

  wantGuardian(on) {
    this.guardianWanted = on;
    this.remember();
    this.emit();
  }

  snapshot() {
    return ORDER.map((id) => {
      const part = { id, ...PARTS[id], ...this.states[id], queued: this.queued.has(id) || (this.plan.has(id) && this.states[id]?.status === "missing") };
      if (!GGUF[id]) return part;
      const extra = id === "omni" ? OMNI_PROJECTOR.bytes : 0;
      const quant = quantOf(id);
      return {
        ...part,
        size: gb(quant.bytes + extra),
        bytes: quant.bytes + extra,
        quant: quant.id,
        quants: QUANTS[id].map((q) => ({ ...q, size: gb(q.bytes + extra), onDisk: fs.existsSync(model(`${GGUF[id].prefix}${q.id}.gguf`)) })),
      };
    });
  }

  /** What the setup screen needs to suggest a size: this Mac's memory. */
  get machine() {
    return { memoryGB: Math.round(os.totalmem() / 2 ** 30) };
  }

  emit() {
    bus.emit("parts", { parts: this.snapshot(), busy: this.busy, guardianWanted: this.guardianWanted });
  }

  set(id, state) {
    const was = this.states[id]?.status;
    this.states[id] = state;
    this.emit();
    if (state.status === "running" && was !== "running") for (const hook of this.readyHooks) hook(id);
  }

  onDisk(id) {
    switch (id) {
      case "engine":
        return findEngine() !== null;
      case "small":
        return fs.existsSync(weights("small"));
      case "omni":
        return fs.existsSync(weights("omni")) && fs.existsSync(model(OMNI_PROJECTOR.file));
      case "guardian":
        return fs.existsSync(marker(DIRS.guardian));
      case "browser":
        return fs.existsSync(marker(DIRS.bridge));
    }
    return false;
  }

  installed(id) {
    return this.onDisk(id);
  }

  /** Ready to answer. A model keeps answering with its old size while a new size downloads. */
  running(id) {
    const status = this.states[id]?.status;
    return status === "running" || (status === "installing" && Boolean(this.procs[id]) && this.states[id].live === true);
  }

  get ready() {
    return this.installed("engine") && (this.installed("small") || this.installed("omni"));
  }

  refresh() {
    for (const id of ORDER) {
      const s = this.states[id]?.status;
      if (s === "installing" || s === "starting" || s === "running" || s === "failed") continue;
      this.states[id] = { status: this.onDisk(id) ? "installed" : "missing" };
    }
  }

  // ---- Install ----

  async install(ids) {
    if (this.busy) {
      for (const id of ids) if (ORDER.includes(id)) this.queued.add(id);
      this.remember();
      this.emit();
      return;
    }
    const queue = ORDER.filter((id) => ids.includes(id));
    if ((queue.includes("small") || queue.includes("omni")) && !this.installed("engine") && !queue.includes("engine")) {
      queue.unshift("engine");
    }
    this.busy = true;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.plan = new Set(queue);
    this.remember();
    this.emit();
    try {
      for (const id of queue) {
        this.plan.delete(id);
        this.current = id;
        this.remember();
        if (this.installed(id)) {
          if (!this.running(id)) await this.start(id);
          continue;
        }
        try {
          this.set(id, { status: "installing", text: "Starting…", live: this.running(id) });
          await this.installPart(id, signal);
          // A new size replaces the one that was running.
          if (this.procs[id]) this.stop(id);
          this.set(id, { status: "installed" });
          this.pruneQuants(id);
          await this.start(id);
        } catch (e) {
          const live = this.states[id]?.live && this.procs[id];
          if (signal.aborted) {
            this.set(id, live ? { status: "running" } : { status: this.onDisk(id) ? "installed" : "missing" });
            return;
          }
          this.set(id, live ? { status: "running", error: friendly(e) } : { status: "failed", error: friendly(e) });
        }
      }
    } finally {
      this.busy = false;
      this.controller = null;
      this.plan.clear();
      this.current = null;
      const next = signal.aborted ? [] : [...this.queued];
      this.queued.clear();
      this.remember();
      this.emit();
      if (next.length) this.install(next);
    }
  }

  cancel() {
    this.queued.clear();
    this.controller?.abort();
  }

  progress(id, label) {
    const live = this.states[id]?.live === true;
    return (done, total) =>
      this.set(id, {
        status: "installing",
        live,
        text: total ? `${label} ${bytesText(done)} of ${bytesText(total)}` : `${label} ${bytesText(done)}`,
        fraction: total ? done / total : undefined,
      });
  }

  async installPart(id, signal) {
    const hf = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}?download=true`;
    switch (id) {
      case "engine":
        return this.installEngine(signal);
      case "small":
        return download(hf(GGUF.small.repo, weightsFile("small")), weights("small"), {
          signal,
          onProgress: this.progress(id, "Downloading"),
        });
      case "omni":
        if (!fs.existsSync(model(OMNI_PROJECTOR.file))) {
          await download(hf(GGUF.omni.repo, OMNI_PROJECTOR.file), model(OMNI_PROJECTOR.file), {
            signal,
            onProgress: this.progress(id, "Downloading the eyes and ears"),
          });
        }
        return download(hf(GGUF.omni.repo, weightsFile("omni")), weights("omni"), {
          signal,
          onProgress: this.progress(id, "Downloading the brain"),
        });
      case "guardian":
        return this.installGuardian(signal);
      case "browser":
        return this.installBrowser(signal);
    }
  }

  async installEngine(signal) {
    const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10", {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`Couldn't reach GitHub (HTTP ${res.status}).`);
    const releases = await res.json();
    const asset = releases.flatMap((r) => r.assets ?? []).find((a) => a.name.endsWith(ENGINE_ASSET));
    if (!asset) throw new Error("No llama.cpp build for this computer was found.");
    const archive = path.join(DIRS.tools, "llama.tar.gz");
    await download(asset.browser_download_url, archive, { signal, onProgress: this.progress("engine", "Downloading") });
    this.set("engine", { status: "installing", text: "Unpacking…" });
    fs.rmSync(DIRS.engine, { recursive: true, force: true });
    fs.mkdirSync(DIRS.engine, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", DIRS.engine], { signal });
    fs.rmSync(archive, { force: true });
    if (!findEngine()) throw new Error("The download didn't contain llama-server.");
  }

  get pythonEnv() {
    return {
      HF_HOME: DIRS.hf,
      UV_CACHE_DIR: path.join(DIRS.tools, "uv-cache"),
      UV_PYTHON_INSTALL_DIR: path.join(DIRS.tools, "python"),
    };
  }

  async ensureUV(signal) {
    const uv = path.join(DIRS.tools, "uv", "uv");
    if (fs.existsSync(uv)) return uv;
    const triple = `${ARCH === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;
    const archive = path.join(DIRS.tools, "uv.tar.gz");
    await download(`https://github.com/astral-sh/uv/releases/latest/download/uv-${triple}.tar.gz`, archive, {
      signal,
      onProgress: this.progress("guardian", "Getting Python tools"),
    });
    fs.mkdirSync(path.dirname(uv), { recursive: true });
    await run("tar", ["-xzf", archive, "-C", path.dirname(uv), "--strip-components=1"], { signal });
    fs.rmSync(archive, { force: true });
    return uv;
  }

  async installGuardian(signal) {
    const uv = await this.ensureUV(signal);
    const venv = path.join(DIRS.guardian, ".venv");
    const env = this.pythonEnv;
    this.set("guardian", { status: "installing", text: "Setting up a private Python…" });
    await run(uv, ["venv", "--allow-existing", "--python", "3.12", venv], { env, signal });
    this.set("guardian", { status: "installing", text: "Installing the safety model's tools (the slow part)…" });
    await run(uv, ["pip", "install", "--python", path.join(venv, "bin", "python"), "-r", path.join(ROOT, "guardian", "requirements.txt")], {
      env,
      signal,
      timeout: 1_800_000,
    });
    this.set("guardian", { status: "installing", text: "Downloading Auto 200M…" });
    await run(path.join(venv, "bin", "python"), ["-I", path.join(ROOT, "guardian", "server.py"), "--download-only"], {
      env,
      signal,
      timeout: 900_000,
    });
    fs.writeFileSync(marker(DIRS.guardian), "");
  }

  get nodeEnv() {
    const bin = path.dirname(process.execPath);
    // Betterwright keeps its browser and profile with the rest of our files, so Remove removes them.
    return { PATH: `${bin}:${process.env.PATH}`, npm_config_cache: path.join(DIRS.tools, "npm-cache"), BETTERWRIGHT_HOME: path.join(DIRS.bridge, "home") };
  }

  async installBrowser(signal) {
    for (const file of ["server.mjs", "package.json"]) {
      fs.copyFileSync(path.join(ROOT, "bridge", file), path.join(DIRS.bridge, file));
    }
    const env = this.nodeEnv;
    this.set("browser", { status: "installing", text: "Installing Betterwright…" });
    await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: DIRS.bridge, env, signal, timeout: 900_000 });
    this.set("browser", { status: "installing", text: "Downloading its browser…" });
    await run("npx", ["betterwright", "setup"], { cwd: DIRS.bridge, env, signal, timeout: 900_000 });
    fs.writeFileSync(marker(DIRS.bridge), "");
  }

  remove(id) {
    this.stop(id);
    switch (id) {
      case "engine":
        fs.rmSync(DIRS.engine, { recursive: true, force: true });
        break;
      case "small":
        this.pruneQuants(id, { all: true });
        break;
      case "omni":
        this.pruneQuants(id, { all: true });
        fs.rmSync(model(OMNI_PROJECTOR.file), { force: true });
        break;
      case "guardian":
        fs.rmSync(DIRS.guardian, { recursive: true, force: true });
        fs.mkdirSync(DIRS.guardian, { recursive: true });
        break;
      case "browser":
        fs.rmSync(DIRS.bridge, { recursive: true, force: true });
        fs.mkdirSync(DIRS.bridge, { recursive: true });
        break;
    }
    this.set(id, { status: "missing" });
  }

  /** Deletes this model's other sizes (or all of them), including half-finished downloads. */
  pruneQuants(id, { all = false } = {}) {
    if (!GGUF[id]) return;
    const keep = all ? null : weightsFile(id);
    let names = [];
    try {
      names = fs.readdirSync(DIRS.models);
    } catch {}
    for (const name of names) {
      if (name.startsWith(GGUF[id].prefix) && name !== keep && name !== `${keep}.part`) fs.rmSync(model(name), { force: true });
    }
  }

  /** Called after the size setting changes: fetches the new size if this model was set up. */
  switchQuant(id) {
    if (!GGUF[id]) return;
    const hadOne = fs.readdirSync(DIRS.models).some((name) => name.startsWith(GGUF[id].prefix) && name.endsWith(".gguf"));
    this.refresh();
    this.emit();
    if (hadOne && !this.installed(id)) this.install([id]);
    else if (this.installed(id)) {
      this.pruneQuants(id);
      if (this.procs[id]) {
        this.stop(id);
        this.start(id);
      }
    }
  }

  // ---- Run ----

  async startAll() {
    await Promise.all(ORDER.filter((id) => id !== "engine" && this.installed(id)).map((id) => this.start(id)));
  }

  command(id) {
    const port = String(PARTS[id].port);
    switch (id) {
      case "small":
      case "omni": {
        const server = findEngine();
        if (!server) return null;
        // Two slots of 16K each: Omni can hold a voice call and transcribe at the same time,
        // with room for thinking. Each request turns thinking on or off itself.
        const args = ["--host", "127.0.0.1", "--port", port, "-c", "32768", "-np", "2", "--jinja", "-ngl", "99", "--reasoning", "auto"];
        if (id === "small") args.push("-m", weights("small"), "--alias", "LFM3-1.7B");
        else args.push("-m", weights("omni"), "--mmproj", model(OMNI_PROJECTOR.file), "--alias", "LFM3-Omni-2B");
        return { cmd: server, args };
      }
      case "guardian":
        return {
          cmd: path.join(DIRS.guardian, ".venv", "bin", "python"),
          args: ["-I", path.join(ROOT, "guardian", "server.py"), "--port", port],
          cwd: DIRS.guardian,
          env: { ...this.pythonEnv, HF_HUB_OFFLINE: "1" },
        };
      case "browser":
        return {
          cmd: process.execPath,
          args: ["server.mjs"],
          cwd: DIRS.bridge,
          env: { ...this.nodeEnv, LA_BROWSER_PORT: port },
        };
    }
    return null;
  }

  async start(id) {
    if (id === "engine" || this.procs[id] || this.launching.has(id) || !this.installed(id)) return;
    const spec = this.command(id);
    if (!spec) return;
    const port = PARTS[id].port;
    this.launching.add(id);
    const free = await this.freePort(port).finally(() => this.launching.delete(id));
    if (!free) {
      this.set(id, { status: "failed", error: `Something else is using port ${port}. Quit it, then click Try again.` });
      return;
    }
    const logFile = path.join(DIRS.logs, `${id}.log`);
    const log = fs.openSync(logFile, "w");
    const child = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", log, log],
    });
    fs.closeSync(log);
    this.procs[id] = child;
    this.set(id, { status: "starting", text: "Waking up…" });
    let exited = false;
    child.on("exit", () => {
      exited = true;
      if (this.procs[id] !== child) return;
      delete this.procs[id];
      const wasRunning = this.running(id);
      this.set(id, wasRunning ? { status: "failed", error: reasonFromLog(logFile, port) } : this.states[id]);
    });
    child.on("error", () => {});
    for (let i = 0; i < 240 && !exited; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          this.set(id, { status: "running" });
          return;
        }
      } catch {}
      await sleep(500);
    }
    if (this.procs[id] === child) {
      delete this.procs[id];
      child.kill("SIGTERM");
    }
    this.set(id, { status: "failed", error: reasonFromLog(logFile, port) });
  }

  stop(id) {
    const child = this.procs[id];
    if (!child) return;
    delete this.procs[id];
    child.kill("SIGTERM");
    this.set(id, { status: this.onDisk(id) ? "installed" : "missing" });
  }

  stopAll() {
    for (const id of Object.keys(this.procs)) {
      this.procs[id].kill("SIGTERM");
      delete this.procs[id];
    }
  }

  /** Frees a port held by a leftover copy of our own servers. Never touches anything else. */
  async freePort(port) {
    let pids = [];
    try {
      pids = (await run("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"])).split("\n").filter(Boolean);
    } catch {
      return true; // lsof exits 1 when nothing listens
    }
    for (const pid of pids) {
      let command = "";
      try {
        command = await run("ps", ["-o", "command=", "-p", pid]);
      } catch {}
      if (!command.includes(DATA)) return false;
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
    }
    await sleep(600);
    return true;
  }

  url(id) {
    return id === "small" ? settings.smallURL : id === "omni" ? settings.omniURL : null;
  }
}

function friendly(e) {
  const text = String(e?.message ?? e);
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET/i.test(text)) return "Couldn't reach the internet. Check your Wi-Fi, then click Try again.";
  if (/ENOSPC/i.test(text)) return "Your Mac is out of disk space. Free some space, then click Try again.";
  return text.slice(0, 300);
}

/** Turns the end of a part's log into a plain-language reason. */
function reasonFromLog(file, port) {
  let tail = "";
  try {
    tail = fs.readFileSync(file, "utf8").slice(-4000).toLowerCase();
  } catch {}
  if (tail.includes("unknown model architecture")) return "The AI engine is too old for this model. Remove the AI engine, then download it again.";
  if (tail.includes("address already in use") || tail.includes("couldn't bind")) return `Something else is using port ${port}. Quit it, then click Try again.`;
  if (tail.includes("failed to load model") || tail.includes("error loading model")) return "The model file looks damaged. Remove it, then download it again.";
  if (tail.includes("out of memory") || tail.includes("failed to allocate")) return "Your Mac ran out of memory. Close some apps, then click Try again.";
  return "It stopped unexpectedly. Click Try again; details are in the logs folder.";
}

export const backends = new Backends();
