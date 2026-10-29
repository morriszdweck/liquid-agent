// Downloads, installs and runs every local part. Downloads come from Hugging
// Face and GitHub once; after that every part runs here on 127.0.0.1.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA, DIRS, ROOT, bus, bytesText, run, settings, sleep } from "./core.js";

export const PARTS = {
  engine: {
    title: "AI engine",
    detail: "Runs the models on your Mac (latest llama.cpp).",
    size: "about 30 MB",
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
    port: 8766,
  },
  browser: {
    title: "Web helper",
    detail: "Betterwright. Lets the agent click around websites for you.",
    size: "about 250 MB",
    port: 8767,
  },
};
export const ORDER = ["engine", "small", "omni", "guardian", "browser"];

const FILES = {
  smallRepo: "LiquidAI/LFM3-1.7B-GGUF",
  small: "LFM3-1.7B-Q4_K_M.gguf",
  omniRepo: "LiquidAI/LFM3-Omni-2B-GGUF",
  omni: "LFM3-Omni-2B-Q4_K_M.gguf",
  omniProjector: "mmproj-LFM3-Omni-2B-Q8_0.gguf",
};

const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const ENGINE_ASSET = process.platform === "darwin" ? `bin-macos-${ARCH}.tar.gz` : `bin-ubuntu-${ARCH}.tar.gz`;

const model = (name) => path.join(DIRS.models, name);
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

  constructor() {
    this.refresh();
    for (const id of ORDER) if (this.states[id].status === "installing") this.states[id] = { status: "missing" };
  }

  snapshot() {
    return ORDER.map((id) => ({ id, ...PARTS[id], ...this.states[id] }));
  }

  emit() {
    bus.emit("parts", { parts: this.snapshot(), busy: this.busy });
  }

  set(id, state) {
    this.states[id] = state;
    this.emit();
  }

  onDisk(id) {
    switch (id) {
      case "engine":
        return findEngine() !== null;
      case "small":
        return fs.existsSync(model(FILES.small));
      case "omni":
        return fs.existsSync(model(FILES.omni)) && fs.existsSync(model(FILES.omniProjector));
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

  running(id) {
    return this.states[id]?.status === "running";
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
    if (this.busy) return;
    const queue = ORDER.filter((id) => ids.includes(id));
    if ((queue.includes("small") || queue.includes("omni")) && !this.installed("engine") && !queue.includes("engine")) {
      queue.unshift("engine");
    }
    this.busy = true;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.emit();
    try {
      for (const id of queue) {
        if (this.installed(id)) {
          if (!this.running(id)) await this.start(id);
          continue;
        }
        try {
          this.set(id, { status: "installing", text: "Starting…" });
          await this.installPart(id, signal);
          this.set(id, { status: "installed" });
          await this.start(id);
        } catch (e) {
          if (signal.aborted) {
            this.set(id, { status: this.onDisk(id) ? "installed" : "missing" });
            return;
          }
          this.set(id, { status: "failed", error: friendly(e) });
        }
      }
    } finally {
      this.busy = false;
      this.controller = null;
      this.emit();
    }
  }

  cancel() {
    this.controller?.abort();
  }

  progress(id, label) {
    return (done, total) =>
      this.set(id, {
        status: "installing",
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
        return download(hf(FILES.smallRepo, FILES.small), model(FILES.small), {
          signal,
          onProgress: this.progress(id, "Downloading"),
        });
      case "omni":
        await download(hf(FILES.omniRepo, FILES.omniProjector), model(FILES.omniProjector), {
          signal,
          onProgress: this.progress(id, "Downloading the ears and eyes"),
        });
        return download(hf(FILES.omniRepo, FILES.omni), model(FILES.omni), {
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
    return { PATH: `${bin}:${process.env.PATH}`, npm_config_cache: path.join(DIRS.tools, "npm-cache") };
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
        fs.rmSync(model(FILES.small), { force: true });
        break;
      case "omni":
        fs.rmSync(model(FILES.omni), { force: true });
        fs.rmSync(model(FILES.omniProjector), { force: true });
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
        // Two slots of 8K each: Omni can hold a voice call and transcribe at the same time.
        const args = ["--host", "127.0.0.1", "--port", port, "-c", "16384", "-np", "2", "--jinja", "-ngl", "99", "--reasoning", "off"];
        if (id === "small") args.push("-m", model(FILES.small), "--alias", "LFM3-1.7B");
        else args.push("-m", model(FILES.omni), "--mmproj", model(FILES.omniProjector), "--alias", "LFM3-Omni-2B");
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
    if (id === "engine" || this.procs[id] || !this.installed(id)) return;
    const spec = this.command(id);
    if (!spec) return;
    const port = PARTS[id].port;
    if (!(await this.freePort(port))) {
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
