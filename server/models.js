// Finds chat models on Hugging Face and checks the GGUF files before they run.
// No network code here runs by itself: backends.js calls these when someone
// adds a model or starts one for the first time.

import fs from "node:fs";

const HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT = /(?:^|[\s._-])((?:IQ\d+|Q\d+)(?:_[A-Za-z0-9]+)*|BF16|FP16|F16|F32|FP32)(?=$|[\s._-])/gi;

/** An error the web server can return with a helpful status. */
export function modelError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** The token people can set for private or gated Hugging Face models. */
export function hfToken() {
  return process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || "";
}

export function hfHeaders(token = hfToken()) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Accepts a Hugging Face link, an org/model pair, or a link to one GGUF file. */
export function parseHfLink(input) {
  const text = String(input ?? "").trim();
  if (!text) throw modelError("Paste a link to a model on Hugging Face.", 400);
  let repo;
  let revision = "main";
  let file;
  if (/^[^/\s]+\/[^/\s]+$/.test(text)) {
    repo = text;
  } else {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw modelError("That doesn't look like a Hugging Face link.", 400);
    }
    if (!HF_HOSTS.has(url.hostname.toLowerCase())) throw modelError("Use a link from huggingface.co.", 400);
    let parts;
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      throw modelError("That link has characters Hugging Face can't read.", 400);
    }
    if (parts.length < 2) throw modelError("That link is missing the model name.", 400);
    repo = `${parts[0]}/${parts[1]}`;
    if (["tree", "blob", "resolve"].includes(parts[2]) && parts[3]) {
      revision = parts[3];
      file = parts.slice(4).join("/");
    }
  }
  repo = repo.replace(/\.git$/i, "");
  if (!REPO.test(repo)) throw modelError("That doesn't look like a Hugging Face model link.", 400);
  if (file) {
    if (!/\.gguf$/i.test(file)) throw modelError("That link points to a file that isn't a GGUF model.", 400);
    if (file.split("/").some((part) => part === ".." || part === ".")) throw modelError("That file path isn't allowed.", 400);
  }
  return { repo, revision, file: file || null };
}

function quantOf(path) {
  const name = path.split("/").pop().replace(/\.gguf$/i, "");
  const matches = [...name.matchAll(QUANT)];
  const found = matches.at(-1)?.[1]?.toUpperCase();
  if (!found) return "GGUF";
  return found.replace("FP16", "F16").replace("FP32", "F32");
}

const PREFERENCES = {
  large: ["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M", "Q4_0", "BF16", "F16"],
  normal: ["Q4_K_M", "Q4_0", "Q5_K_M", "Q5_K_S", "Q6_K", "Q8_0", "BF16", "F16"],
  small: ["Q4_0", "Q4_K_M", "Q3_K_M", "IQ3_XXS", "Q2_K", "Q5_K_M", "Q6_K", "Q8_0", "BF16", "F16"],
};

/** Picks the best size that should fit in this computer's memory. */
function recommend(variants, memoryGB) {
  const cap = Math.max(2, memoryGB || 8) * 0.7e9;
  const sized = variants.filter((v) => v.bytes > 0);
  const fitting = sized.filter((v) => v.bytes <= cap);
  const pool = fitting.length ? fitting : sized.sort((a, b) => a.bytes - b.bytes).slice(0, 1);
  const byQuant = new Map(pool.map((v) => [v.quant, v]));
  const prefs = memoryGB >= 16 ? PREFERENCES.large : memoryGB >= 8 ? PREFERENCES.normal : PREFERENCES.small;
  for (const quant of prefs) {
    const hit = byQuant.get(quant);
    if (hit) return hit.id;
  }
  return (pool[0] ?? variants[0]).id;
}

/** Turns a Hugging Face file list into the sizes offered in Settings. */
export function ggufVariants(files, memoryGB = 8) {
  const warnings = [];
  const singles = [];
  const groups = new Map();
  let projectors = 0;
  for (const entry of files ?? []) {
    if (entry.type && entry.type !== "file") continue;
    const path = String(entry.path ?? "");
    if (!/\.gguf$/i.test(path)) continue;
    if (/mmproj/i.test(path)) {
      projectors += 1;
      continue;
    }
    const bytes = Number(entry.size ?? entry.lfs?.size ?? 0) || 0;
    const shard = path.match(SHARD);
    if (shard) {
      const [, base, index, total] = shard;
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push({ path, index: Number(index), total: Number(total), bytes });
    } else {
      singles.push({ path, bytes });
    }
  }

  const variants = singles.map((file) => ({
    id: file.path,
    file: file.path,
    quant: quantOf(file.path),
    bytes: file.bytes,
    shards: [file.path],
    shardBytes: [file.bytes],
  }));

  for (const [base, parts] of groups) {
    const total = parts[0]?.total ?? 0;
    const indexes = new Set(parts.map((p) => p.index));
    const complete = total > 0 && parts.length === total && parts.every((p) => p.total === total) && [...Array(total)].every((_, i) => indexes.has(i + 1));
    if (!complete) {
      warnings.push(`${base.split("/").pop()} is missing one or more parts, so it was skipped.`);
      continue;
    }
    const shards = [...parts].sort((a, b) => a.index - b.index).map((p) => p.path);
    variants.push({
      id: shards[0],
      file: shards[0],
      quant: quantOf(base),
      bytes: parts.reduce((sum, p) => sum + p.bytes, 0),
      shards,
      shardBytes: [...parts].sort((a, b) => a.index - b.index).map((p) => p.bytes),
    });
  }

  if (projectors) warnings.push("This repository also has a vision or audio projector; only the text model is used here.");
  if (!variants.length) throw modelError("No GGUF files found in this repository. Pick a GGUF version of the model.", 422);

  variants.sort((a, b) => (a.bytes || Number.MAX_SAFE_INTEGER) - (b.bytes || Number.MAX_SAFE_INTEGER));
  const recommended = recommend(variants, memoryGB);
  const smallest = variants[0];
  const largest = variants[variants.length - 1];
  for (const variant of variants) {
    variant.recommended = variant.id === recommended;
    variant.label = variant.recommended ? "Recommended" : variant === smallest ? "Smallest" : variant === largest ? "Best" : "Balanced";
    if (variant.shards.length > 1) variant.note = `${variant.shards.length} parts`;
  }
  return { variants, recommended, warnings };
}

async function getJson(url, { fetchImpl, token }) {
  let res;
  try {
    res = await fetchImpl(url, { headers: hfHeaders(token), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    if (e?.name === "TimeoutError") throw modelError("Hugging Face took too long to answer. Try again.", 504);
    throw modelError("Couldn't reach Hugging Face. Check your internet, then try again.", 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw modelError("This model is private or gated. Accept its terms on Hugging Face, or set HF_TOKEN and restart Liquid Agent.", 403);
  }
  if (res.status === 404) throw modelError("No model found at that link.", 404);
  if (res.status === 429) throw modelError("Hugging Face is busy. Wait a minute, then try again.", 429);
  if (!res.ok) throw modelError(`Hugging Face answered ${res.status}. Try again.`, 502);
  try {
    return await res.json();
  } catch {
    throw modelError("Hugging Face sent an answer Liquid Agent couldn't read.", 502);
  }
}

/** Looks up a model and every GGUF file it offers. */
export async function resolveHfModel(link, { fetchImpl = fetch, token = hfToken(), memoryGB = 8 } = {}) {
  const { repo, revision, file } = parseHfLink(link);
  const infoUrl = `https://huggingface.co/api/models/${repo.split("/").map(encodeURIComponent).join("/")}`;
  const treeUrl = `${infoUrl}/tree/${encodeURIComponent(revision)}?recursive=true&expand=true`;
  const [info, tree] = await Promise.all([getJson(infoUrl, { fetchImpl, token }), getJson(treeUrl, { fetchImpl, token })]);
  if (!Array.isArray(tree)) throw modelError("Hugging Face sent a file list Liquid Agent couldn't read.", 502);
  const { variants, recommended, warnings } = ggufVariants(tree, memoryGB);
  const requested = file ? variants.find((v) => v.file === file || v.shards.includes(file)) : null;
  if (file && !requested) throw modelError("That file isn't a text GGUF model in this repository.", 400);
  const card = info.cardData ?? {};
  const license = card.license_name || card.license || null;
  const linkValue = card.license_link;
  const licenseUrl =
    typeof linkValue === "string" && /^https?:\/\//i.test(linkValue)
      ? linkValue
      : typeof linkValue === "string" && linkValue
        ? `https://huggingface.co/${repo}/blob/${revision}/${linkValue.replace(/^\/+/, "")}`
        : `https://huggingface.co/${repo}`;
  return {
    repo,
    revision,
    label: card.model_name || info.modelId?.split("/").pop() || repo.split("/").pop(),
    license,
    licenseUrl,
    gated: Boolean(info.gated),
    variants: variants.map((v) => ({ ...v, size: `${(v.bytes / 1e9).toFixed(1)} GB` })),
    recommended,
    requested: requested?.id ?? null,
    warning: warnings.join(" ") || undefined,
  };
}

const NUMERIC = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const MAX_STRING = 20_000_000;
const MAX_ARRAY = 50_000_000;
const CHUNK = 1 << 20;

/** Reads a GGUF header without loading the whole model. */
export function probeGGUF(file) {
  const fd = fs.openSync(file, "r");
  const size = fs.fstatSync(fd).size;
  let buffer = Buffer.alloc(0);
  let cursor = 0;
  let bufferStart = 0;

  const ensure = (n) => {
    if (buffer.length - cursor >= n) return;
    const keep = buffer.subarray(cursor);
    const readAt = bufferStart + buffer.length;
    const want = Math.max(CHUNK, n);
    const next = Buffer.alloc(want);
    const got = fs.readSync(fd, next, 0, want, readAt);
    if (got + keep.length < n) throw modelError("That file ended before its header did.", 422);
    buffer = Buffer.concat([keep, got === want ? next : next.subarray(0, got)]);
    bufferStart = readAt - keep.length;
    cursor = 0;
  };
  const take = (n) => {
    ensure(n);
    const value = buffer.subarray(cursor, cursor + n);
    cursor += n;
    return value;
  };
  const skip = (n) => {
    if (n < 0) throw modelError("That GGUF header is damaged.", 422);
    const available = buffer.length - cursor;
    if (n <= available) {
      cursor += n;
      return;
    }
    const left = n - available;
    bufferStart = bufferStart + buffer.length + left;
    buffer = Buffer.alloc(0);
    cursor = 0;
  };
  const u32 = () => take(4).readUInt32LE(0);
  const u64 = () => Number(take(8).readBigUInt64LE(0));
  const text = () => {
    const n = u64();
    if (n > MAX_STRING) throw modelError("That GGUF header is damaged.", 422);
    return take(n).toString("utf8");
  };
  const value = (type) => {
    if (type === 8) return text();
    if (type === 9) {
      const item = u32();
      const count = u64();
      if (count > MAX_ARRAY) throw modelError("That GGUF header is damaged.", 422);
      if (item === 8) {
        for (let i = 0; i < count; i++) skip(u64());
      } else {
        const width = NUMERIC[item];
        if (!width) throw modelError("That GGUF header uses an unknown value type.", 422);
        skip(count * width);
      }
      return undefined;
    }
    const width = NUMERIC[type];
    if (!width) throw modelError("That GGUF header uses an unknown value type.", 422);
    const raw = take(width);
    if (type === 4) return raw.readUInt32LE(0);
    if (type === 5) return raw.readInt32LE(0);
    if (type === 10) return Number(raw.readBigUInt64LE(0));
    if (type === 11) return Number(raw.readBigInt64LE(0));
    if (type === 6) return raw.readFloatLE(0);
    return undefined;
  };

  try {
    if (size < 24) throw modelError("That file is too small to be a GGUF model.", 422);
    if (take(4).toString("ascii") !== "GGUF") throw modelError("That file isn't a GGUF model.", 422);
    const version = u32();
    if (version < 1 || version > 3) throw modelError(`That GGUF version (${version}) isn't supported.`, 422);
    const tensors = u64();
    const pairs = u64();
    if (tensors > 1_000_000 || pairs > 100_000) throw modelError("That GGUF header is damaged.", 422);
    const found = new Map();
    for (let i = 0; i < pairs; i++) {
      const key = text();
      const type = u32();
      const raw = value(type);
      if (typeof raw === "string" || typeof raw === "number") found.set(key, raw);
    }
    const architecture = found.get("general.architecture") ?? null;
    const contextLength = Number(found.get(architecture ? `${architecture}.context_length` : "context_length")) || null;
    const template = found.get("tokenizer.chat_template");
    return {
      architecture,
      contextLength,
      hasTemplate: typeof template === "string" && template.length > 0,
      thinking: typeof template === "string" && template.includes("enable_thinking"),
      name: found.get("general.name") ?? null,
    };
  } finally {
    fs.closeSync(fd);
  }
}
