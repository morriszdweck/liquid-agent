// Downloads, installs and runs every local part. Downloads come from Hugging
// Face and GitHub once; after that every part runs here on 127.0.0.1.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DATA, DEVICE, DIRS, IS_MAC, QUANTS, ROOT, bus, bytesText, load, run, save, settings, sleep } from "./core.js";
import { hfHeaders, modelError, probeGGUF, resolveHfModel } from "./models.js";
import { linuxGPU, listeners } from "./platform.js";

export const PARTS = {
  engine: {
    title: "AI engine",
    detail: `Runs the models on your ${DEVICE} (latest llama.cpp).`,
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
const CUSTOM_FILE = "custom-model.json";
const CUSTOM_DIR = path.join(DIRS.models, "custom");

const ARCH = process.arch === "arm64" ? "arm64" : "x64";

/**
 * Which llama.cpp build runs the models. A Mac always uses Metal. On Linux it's
 * Vulkan when a real GPU driver is installed (NVIDIA, AMD or Intel), else the
 * CPU build. CUDA is faster on NVIDIA but a much bigger download, so it's only
 * used when LIQUID_AGENT_GPU=cuda. LIQUID_AGENT_GPU=cpu or vulkan also works.
 */
const FLAVOR = (() => {
  if (IS_MAC) return "metal";
  const gpu = linuxGPU();
  const wanted = process.env.LIQUID_AGENT_GPU;
  if (wanted === "cuda" && gpu.nvidiaDriver >= 525) return "cuda";
  if (wanted === "cpu" || wanted === "vulkan") return wanted;
  return gpu.vulkan ? "vulkan" : "cpu";
})();
const ENGINE_TEXT = {
  metal: "Runs the models on your Mac (latest llama.cpp).",
  vulkan: "Runs the models on your graphics card with Vulkan (latest llama.cpp).",
  cuda: "Runs the models on your NVIDIA graphics card with CUDA (latest llama.cpp).",
  cpu: "Runs the models on your computer's processor (latest llama.cpp).",
};

/** The release file for this computer. CUDA builds come per CUDA version; take the newest the driver can run. */
function engineAsset(assets) {
  const find = (suffix) => assets.find((a) => a.name.startsWith("llama-") && a.name.endsWith(suffix));
  if (FLAVOR === "metal") return find(`bin-macos-${ARCH}.tar.gz`);
  if (FLAVOR === "vulkan") return find(`bin-ubuntu-vulkan-${ARCH}.tar.gz`);
  if (FLAVOR === "cuda") {
    const driver = linuxGPU().nvidiaDriver ?? 0;
    const builds = assets
      .map((a) => ({ a, v: a.name.match(new RegExp(`^llama-.*bin-ubuntu-cuda-(\\d+)\\.(\\d+)-${ARCH}\\.tar\\.gz$`)) }))
      .filter((x) => x.v && (Number(x.v[1]) >= 13 ? driver >= 580 : driver >= 525))
      .sort((x, y) => Number(y.v[1]) - Number(x.v[1]) || Number(y.v[2]) - Number(x.v[2]));
    if (builds.length) return builds[0].a;
  }
  return find(`bin-ubuntu-${ARCH}.tar.gz`);
}

const model = (name) => path.join(DIRS.models, name);
const weights = (id) => model(weightsFile(id));
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const marker = (dir) => path.join(dir, ".ready");

const isGguf = (name) => typeof name === "string" && /\.gguf$/i.test(name) && name.split("/").every((part) => part && part !== "." && part !== "..");
const customPath = (name) => {
  if (!isGguf(name)) throw modelError("That model file has an unsafe name.", 400);
  const full = path.join(CUSTOM_DIR, name);
  if (!full.startsWith(CUSTOM_DIR + path.sep)) throw modelError("That model file has an unsafe name.", 400);
  return full;
};
const variantOf = (custom) => custom?.variants?.find((v) => v.id === custom.file) ?? null;
const variantOnDisk = (variant) => Boolean(variant) && variant.shards.every((shard) => fs.existsSync(customPath(shard)));

/** Keeps a saved custom model from doing anything unexpected after a restart. */
function cleanCustom(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.repo !== "string" || typeof raw.file !== "string" || !Array.isArray(raw.variants)) return null;
  const variants = raw.variants
    .filter((v) => v && typeof v.id === "string" && typeof v.file === "string" && Array.isArray(v.shards) && v.shards.length > 0 && v.shards.every(isGguf) && typeof v.bytes === "number")
    .slice(0, 100)
    .map((v) => ({
      id: v.id,
      file: v.file,
      quant: typeof v.quant === "string" ? v.quant : "GGUF",
      bytes: v.bytes,
      shards: v.shards,
      shardBytes: Array.isArray(v.shardBytes) ? v.shardBytes.filter((n) => typeof n === "number") : undefined,
      label: typeof v.label === "string" ? v.label : "Balanced",
      ...(typeof v.note === "string" ? { note: v.note } : {}),
    }));
  const selected = variants.find((v) => v.id === raw.file);
  if (!variants.length || !selected) return null;
  return {
    ...selected,
    repo: raw.repo,
    revision: typeof raw.revision === "string" ? raw.revision : "main",
    label: typeof raw.label === "string" ? raw.label : raw.repo.split("/").pop(),
    license: typeof raw.license === "string" ? raw.license : null,
    licenseUrl: typeof raw.licenseUrl === "string" ? raw.licenseUrl : null,
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : Date.now(),
    variants,
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : null,
  };
}

/** Deletes every custom model file except the ones the chosen size needs. */
function pruneCustom(keep) {
  const keepSet = new Set(keep.map((name) => path.resolve(customPath(name))));
  const walk = (dir) => {
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) walk(full);
      else if (!keepSet.has(path.resolve(full))) fs.rmSync(full, { force: true });
    }
    try {
      if (dir !== CUSTOM_DIR && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {}
  };
  walk(CUSTOM_DIR);
}

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
async function download(url, dest, { onProgress, signal, headers } = {}) {
  const part = dest + ".part";
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, { signal, headers: { ...headers, ...(start ? { Range: `bytes=${start}-` } : {}) } });
  if (res.status === 416) {
    fs.renameSync(part, dest);
    return;
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("This model is private or gated. Accept its terms on Hugging Face, or set HF_TOKEN and restart Liquid Agent.");
    throw new Error(`Download failed (HTTP ${res.status}). Check your internet and try again.`);
  }
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
  /** The GPU build failed to start a model, so models run on the CPU until the app restarts. */
  cpuOnly = false;
  /** A model someone added from Hugging Face; it replaces the Everyday brain when set. */
  custom = cleanCustom(load(CUSTOM_FILE, null));

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
      if (id === "engine") return { ...part, ...this.engineInfo };
      if (id === "small" && this.custom) {
        const custom = this.custom;
        return {
          ...part,
          detail: `${custom.label} · ${custom.repo}${custom.meta?.hasTemplate === false ? " · no chat template" : ""}`,
          size: gb(custom.bytes),
          bytes: custom.bytes,
          quant: custom.file,
          custom: {
            repo: custom.repo,
            revision: custom.revision,
            label: custom.label,
            license: custom.license,
            licenseUrl: custom.licenseUrl,
            file: custom.file,
            quant: custom.quant,
            bytes: custom.bytes,
            meta: custom.meta,
          },
          quants: custom.variants.map((v) => ({
            id: v.id,
            label: v.label,
            quant: v.quant,
            bytes: v.bytes,
            size: gb(v.bytes),
            note: v.note,
            onDisk: variantOnDisk(v),
          })),
        };
      }
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

  /** What the setup screen needs to suggest a size: this computer's memory. */
  get machine() {
    return { memoryGB: Math.round(os.totalmem() / 2 ** 30), os: process.platform, gpu: FLAVOR };
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
        if (this.custom) return variantOnDisk(variantOf(this.custom));
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

  // ---- A model from Hugging Face ----

  /** Looks up a Hugging Face link without downloading or changing anything. */
  async resolveModel(link) {
    return resolveHfModel(link, { memoryGB: this.machine.memoryGB });
  }

  /** Replaces the Everyday brain with a GGUF model from Hugging Face. */
  async setCustomModel(link, file) {
    if (this.busy) throw modelError("Wait for the current download to finish, then add the model.", 409);
    const resolved = await resolveHfModel(link, { memoryGB: this.machine.memoryGB });
    const wanted = [file, resolved.requested, resolved.recommended].filter(Boolean);
    const variant = resolved.variants.find((v) => wanted.includes(v.id));
    if (!variant) throw modelError("Pick one of the sizes Hugging Face offered.", 400);
    const previous = this.custom;
    const next = cleanCustom({
      repo: resolved.repo,
      revision: resolved.revision,
      label: resolved.label,
      license: resolved.license,
      licenseUrl: resolved.licenseUrl,
      variants: resolved.variants,
      file: variant.file,
      quant: variant.quant,
      bytes: variant.bytes,
      shards: variant.shards,
      shardBytes: variant.shardBytes,
      addedAt: Date.now(),
      meta: null,
    });
    if (!next) throw modelError("That model's files couldn't be used.", 422);
    this.stop("small");
    // A different repo can reuse a file name. Remove the old download so it can't be mistaken for the new one.
    if (!previous || previous.repo !== resolved.repo || previous.revision !== resolved.revision || previous.file !== variant.file) {
      fs.rmSync(CUSTOM_DIR, { recursive: true, force: true });
    }
    this.custom = next;
    save(CUSTOM_FILE, this.custom);
    this.refresh();
    this.emit();
    this.install(["small"]).catch(() => {});
    return this.snapshot().find((p) => p.id === "small");
  }

  /** Switches to another size of the same custom model. */
  setCustomQuant(file) {
    if (this.busy) throw modelError("Wait for the current download to finish, then change the size.", 409);
    if (!this.custom) throw modelError("Add a model from Hugging Face first.", 400);
    const variant = this.custom.variants.find((v) => v.id === file);
    if (!variant) throw modelError("That size isn't available for this model.", 400);
    if (variant.file === this.custom.file) {
      if (this.installed("small") && !this.running("small")) this.start("small");
      return this.snapshot().find((p) => p.id === "small");
    }
    this.stop("small");
    const next = cleanCustom({
      ...this.custom,
      file: variant.file,
      quant: variant.quant,
      bytes: variant.bytes,
      shards: variant.shards,
      shardBytes: variant.shardBytes,
      meta: null,
    });
    if (!next) throw modelError("That size couldn't be used.", 422);
    this.custom = next;
    save(CUSTOM_FILE, this.custom);
    this.refresh();
    this.emit();
    this.install(["small"]).catch(() => {});
    return this.snapshot().find((p) => p.id === "small");
  }

  /** Goes back to the built-in LFM3 1.7B and deletes the custom download. */
  clearCustomModel() {
    if (this.busy) throw modelError("Wait for the current download to finish, then switch back.", 409);
    if (!this.custom) return this.snapshot().find((p) => p.id === "small");
    this.stop("small");
    this.custom = null;
    fs.rmSync(path.join(DATA, CUSTOM_FILE), { force: true });
    fs.rmSync(CUSTOM_DIR, { recursive: true, force: true });
    this.refresh();
    this.emit();
    if (this.installed("small")) this.start("small");
    return this.snapshot().find((p) => p.id === "small");
  }

  /** Whether Think does anything for this model. */
  supportsThinking(id) {
    if (id !== "small") return false;
    return !this.custom || this.custom.meta?.thinking !== false;
  }

  /** Tokens the model can hold at once, for sizing an answer. */
  contextTokens(id) {
    if (id === "small" && this.custom?.meta?.contextLength) return this.custom.meta.contextLength;
    return 32768;
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
        if (this.custom) return this.installCustom(signal);
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

  /** Downloads every part of a custom model, then checks its GGUF header. */
  async installCustom(signal) {
    const custom = this.custom;
    const variant = variantOf(custom);
    if (!custom || !variant) throw modelError("No model from Hugging Face is selected.", 400);
    fs.mkdirSync(CUSTOM_DIR, { recursive: true });
    for (const shard of variant.shards) fs.mkdirSync(path.dirname(customPath(shard)), { recursive: true });
    const sizes = variant.shardBytes?.length === variant.shards.length ? variant.shardBytes : variant.shards.map(() => 0);
    const total = sizes.reduce((sum, n) => sum + n, 0) || variant.bytes || 0;
    const live = this.states.small?.live === true;
    const repo = custom.repo.split("/").map(encodeURIComponent).join("/");
    const revision = encodeURIComponent(custom.revision || "main");
    let base = 0;
    for (let i = 0; i < variant.shards.length; i++) {
      const shard = variant.shards[i];
      const dest = customPath(shard);
      const name = shard.split("/").map(encodeURIComponent).join("/");
      const label = `Downloading ${variant.quant}`;
      await download(`https://huggingface.co/${repo}/resolve/${revision}/${name}`, dest, {
        signal,
        headers: hfHeaders(),
        onProgress: (done) => {
          const soFar = base + done;
          this.set("small", {
            status: "installing",
            live,
            text: total ? `${label} ${bytesText(soFar)} of ${bytesText(total)}` : `${label} ${bytesText(soFar)}`,
            fraction: total ? Math.min(1, soFar / total) : undefined,
          });
        },
      });
      base += sizes[i] || fs.statSync(dest).size;
    }
    this.set("small", { status: "installing", live, text: "Checking the model…", fraction: 1 });
    const meta = probeGGUF(customPath(variant.file));
    const next = cleanCustom({
      ...custom,
      file: variant.file,
      quant: variant.quant,
      bytes: variant.bytes,
      shards: variant.shards,
      shardBytes: variant.shardBytes,
      meta,
    });
    if (!next) throw modelError("That model's files couldn't be used.", 422);
    this.custom = next;
    save(CUSTOM_FILE, this.custom);
    pruneCustom(variant.shards);
  }

  /** The engine row's text: what it runs on, and a bigger size for CUDA. */
  get engineInfo() {
    const flavor = this.cpuOnly ? "cpu" : (this.engineFlavor() ?? FLAVOR);
    return { detail: ENGINE_TEXT[flavor], ...(flavor === "cuda" && { size: "about 600 MB", bytes: 0.6e9 }) };
  }

  /** The build that was downloaded, or null before there is one. */
  engineFlavor() {
    try {
      return fs.readFileSync(path.join(DIRS.engine, ".flavor"), "utf8").trim() || null;
    } catch {
      return findEngine() ? (IS_MAC ? "metal" : "cpu") : null;
    }
  }

  async installEngine(signal) {
    const res = await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10", {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`Couldn't reach GitHub (HTTP ${res.status}).`);
    const releases = await res.json();
    // Take the newest release that has this computer's build, and for CUDA the matching runtime from the same release.
    let asset;
    let runtime;
    for (const r of releases) {
      asset = engineAsset(r.assets ?? []);
      if (!asset) continue;
      const cuda = asset.name.match(/bin-ubuntu-cuda-[\d.]+-\w+\.tar\.gz$/)?.[0];
      runtime = cuda && r.assets.find((a) => a.name.startsWith("cudart-") && a.name.endsWith(cuda));
      if (!cuda || runtime) break;
    }
    if (!asset) throw new Error("No llama.cpp build for this computer was found.");
    const archive = path.join(DIRS.tools, "llama.tar.gz");
    const extra = path.join(DIRS.tools, "cudart.tar.gz");
    await download(asset.browser_download_url, archive, { signal, onProgress: this.progress("engine", "Downloading") });
    if (runtime) await download(runtime.browser_download_url, extra, { signal, onProgress: this.progress("engine", "Downloading CUDA") });
    this.set("engine", { status: "installing", text: "Unpacking…" });
    fs.rmSync(DIRS.engine, { recursive: true, force: true });
    fs.mkdirSync(DIRS.engine, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", DIRS.engine], { signal });
    fs.rmSync(archive, { force: true });
    const server = findEngine();
    if (!server) throw new Error("The download didn't contain llama-server.");
    if (runtime) {
      // The CUDA libraries go next to llama-server, where it looks for them.
      await run("tar", ["-xzf", extra, "-C", path.dirname(server), "--strip-components", "1"], { signal });
      fs.rmSync(extra, { force: true });
    }
    const flavor = asset.name.includes("-cuda-") ? "cuda" : asset.name.includes("-vulkan-") ? "vulkan" : IS_MAC ? "metal" : "cpu";
    fs.writeFileSync(path.join(DIRS.engine, ".flavor"), flavor);
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
    // Auto 200M is small enough for the CPU. On Linux the default PyTorch brings gigabytes of CUDA libraries, so take the CPU build.
    const torch = IS_MAC ? [] : ["--torch-backend", "cpu"];
    await run(uv, ["pip", "install", ...torch, "--python", path.join(venv, "bin", "python"), "-r", path.join(ROOT, "guardian", "requirements.txt")], {
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
    // Betterwright's own browser is built for macOS on Apple silicon and Linux on x86_64.
    if (!IS_MAC && ARCH !== "x64") throw new Error("The Web helper's browser isn't available for Linux on ARM yet.");
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
        if (this.custom) {
          this.custom = null;
          fs.rmSync(path.join(DATA, CUSTOM_FILE), { force: true });
          fs.rmSync(CUSTOM_DIR, { recursive: true, force: true });
        } else {
          this.pruneQuants(id, { all: true });
        }
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
    this.set(id, { status: this.onDisk(id) ? "installed" : "missing" });
  }

  /** Deletes this model's other sizes (or all of them), including half-finished downloads. */
  pruneQuants(id, { all = false } = {}) {
    if (!GGUF[id] || (id === "small" && this.custom)) return;
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
    if (!GGUF[id] || (id === "small" && this.custom)) return;
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
        const custom = id === "small" ? this.custom : null;
        const variant = variantOf(custom);
        if (custom && !variant) return null;
        const context = custom?.meta?.contextLength ? Math.min(32768, Math.max(512, custom.meta.contextLength)) : 32768;
        // Omni keeps two slots for a voice call and dictation at the same time. A custom
        // text model gets one, so its whole context is available to a chat.
        const slots = custom ? 1 : 2;
        // Each request turns thinking on or off itself.
        const args = ["--host", "127.0.0.1", "--port", port, "-c", String(context), "-np", String(slots), "-ngl", "99", "--reasoning", "auto"];
        if (custom?.meta?.hasTemplate !== false) args.push("--jinja");
        if (this.cpuOnly) args.push("--device", "none");
        if (id === "small") args.push("-m", custom ? customPath(variant.file) : weights("small"), "--alias", "LFM3-1.7B");
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
    if (await this.launch(id)) return;
    // A GPU build that can't use the GPU (an old driver, a missing library) still runs on the CPU.
    const gpu = ["vulkan", "cuda"].includes(this.engineFlavor());
    if ((id === "small" || id === "omni") && gpu && !this.cpuOnly && this.states[id]?.status === "failed" && !/port \d+/.test(this.states[id].error)) {
      this.cpuOnly = true;
      this.set(id, { status: "starting", text: "The graphics card didn't work, so trying the processor…" });
      for (const other of ["small", "omni"]) {
        if (other === id || !this.procs[other]) continue;
        this.stop(other);
        this.start(other);
      }
      await this.launch(id);
    }
  }

  /** Starts one part and waits for it to answer. True once it's running. */
  async launch(id) {
    const spec = this.command(id);
    if (!spec) return false;
    const port = PARTS[id].port;
    this.launching.add(id);
    const free = await this.freePort(port).finally(() => this.launching.delete(id));
    if (!free) {
      this.set(id, { status: "failed", error: `Something else is using port ${port}. Quit it, then click Try again.` });
      return false;
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
          return true;
        }
      } catch {}
      await sleep(500);
    }
    if (this.procs[id] === child) {
      delete this.procs[id];
      child.kill("SIGTERM");
    }
    this.set(id, { status: "failed", error: reasonFromLog(logFile, port) });
    return false;
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
    const found = await listeners(port);
    if (!found.length) return true;
    for (const { pid, command } of found) {
      if (!pid || !command.includes(DATA)) return false;
      try {
        process.kill(pid, "SIGTERM");
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
  if (/private or gated/.test(text)) return text;
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET/i.test(text)) return "Couldn't reach the internet. Check your Wi-Fi, then click Try again.";
  if (/ENOSPC/i.test(text)) return `Your ${DEVICE} is out of disk space. Free some space, then click Try again.`;
  return text.slice(0, 300);
}

/** Turns the end of a part's log into a plain-language reason. */
function reasonFromLog(file, port) {
  let tail = "";
  try {
    tail = fs.readFileSync(file, "utf8").slice(-4000).toLowerCase();
  } catch {}
  if (tail.includes("unknown model architecture")) return "The AI engine is too old for this model. Remove the AI engine, then download it again.";
  if (tail.includes("chat template") || tail.includes("chat_template")) return "This model's GGUF file has no chat template, so it can't answer chat messages. Try another GGUF version of it.";
  if (tail.includes("address already in use") || tail.includes("couldn't bind")) return `Something else is using port ${port}. Quit it, then click Try again.`;
  if (tail.includes("failed to load model") || tail.includes("error loading model")) return "The model file looks damaged. Remove it, then download it again.";
  if (tail.includes("out of memory") || tail.includes("failed to allocate")) return `Your ${DEVICE} ran out of memory. Close some apps, then click Try again.`;
  if (/glibc_[\d.]+' not found/.test(tail)) return "This Linux is too old for the AI engine. It needs glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 or later).";
  if (tail.includes("error while loading shared libraries")) return `The AI engine is missing a system library: ${tail.match(/loading shared libraries: ([^:]+)/)?.[1] ?? "see the logs"}.`;
  return "It stopped unexpectedly. Click Try again; details are in the logs folder.";
}

export const backends = new Backends();
