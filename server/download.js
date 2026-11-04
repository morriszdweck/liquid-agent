// Downloads big files (the models are 1-4 GB) so that a flaky connection can't
// stop them. A dropped or stalled connection picks up where it left off, the
// computer stays awake while a download runs, and a Hugging Face file is checked
// against its published size and SHA-256 before it's used.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { IS_MAC } from "./core.js";

/** No bytes for this long means the connection is dead even if it's still open. */
const STALL_MS = 45_000;
/** Attempts in a row that get no bytes at all before giving up. Any progress resets the count. */
const TRIES = 8;
/** Writes go to disk in blocks this big instead of one small chunk at a time. */
const BLOCK = 1 << 20;

/** A failure that trying again won't fix (a missing or gated file, a full disk). */
class Fatal extends Error {}

const size = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", stop, { once: true });
  });

/**
 * Downloads url to dest through dest.part, resuming whatever is already there.
 * onProgress(done, total, note) gets a note while it waits to reconnect or checks the file.
 */
export async function download(url, dest, { onProgress, signal, headers } = {}) {
  const part = dest + ".part";
  const awake = keepAwake();
  try {
    const expected = await published(url, { signal, headers });
    let failures = 0;
    let fresh = false;
    for (;;) {
      signal?.throwIfAborted();
      // A leftover bigger than the file is from something else: start over.
      if (expected.size && size(part) > expected.size) fs.rmSync(part, { force: true });
      const before = size(part);
      try {
        await attempt(url, part, { onProgress, signal, headers, expected });
      } catch (e) {
        if (signal?.aborted || e instanceof Fatal) throw e;
        failures = size(part) > before ? 1 : failures + 1;
        if (failures >= TRIES) throw e;
        const seconds = Math.min(30, 2 ** failures);
        onProgress?.(size(part), expected.size, `Connection dropped. Trying again in ${seconds}s…`);
        await wait(seconds * 1000, signal);
        continue;
      }
      if (!expected.sha256) break;
      onProgress?.(size(part), expected.size, "Checking the download…");
      if ((await sha256(part, signal)) === expected.sha256) break;
      // Damaged on the way (or a leftover from an older copy of the file): get it again, once.
      fs.rmSync(part, { force: true });
      if (fresh) throw new Fatal("The download came out damaged twice. Check your internet, then click Try again.");
      fresh = true;
      failures = 0;
    }
    fs.renameSync(part, dest);
  } finally {
    awake();
  }
}

/** What Hugging Face says the file is. It sends both on the redirect to its file servers. */
async function published(url, { signal, headers }) {
  if (!/^https:\/\/huggingface\.co\//.test(url)) return {};
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: anySignal(signal, 15_000), headers });
    const bytes = Number(res.headers.get("x-linked-size")) || 0;
    const etag = (res.headers.get("x-linked-etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
    return { size: bytes, sha256: /^[0-9a-f]{64}$/.test(etag) ? etag : null };
  } catch (e) {
    if (signal?.aborted) throw e;
    // Not knowing only skips the check; the download itself still runs.
    return {};
  }
}

/** One request: appends to part from where it stops. Throws if the connection drops early. */
async function attempt(url, part, { onProgress, signal, headers, expected }) {
  let start = size(part);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("The connection stalled.")), STALL_MS);
  };
  let handle = null;
  try {
    arm();
    const res = await fetch(url, { signal: controller.signal, headers: { ...headers, ...(start ? { Range: `bytes=${start}-` } : {}) } });
    if (res.status === 416) {
      // Every byte is already here, unless the leftover doesn't match the file.
      const all = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1]) || expected.size;
      if (all && start !== all) {
        fs.rmSync(part, { force: true });
        throw new Error("The partial download didn't match. Starting it again.");
      }
      return;
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403)
        throw new Fatal("This model is private or gated. Accept its terms on Hugging Face, or set HF_TOKEN and restart Liquid Agent.");
      if (res.status === 404) throw new Fatal("That file isn't there anymore (HTTP 404).");
      throw new Error(`Download failed (HTTP ${res.status}). Check your internet and try again.`);
    }
    if (res.status !== 206) start = 0;
    const total = expected.size || start + (Number(res.headers.get("content-length")) || 0);
    handle = await fs.promises.open(part, start ? "a" : "w");
    let done = start;
    let last = 0;
    let block = [];
    let held = 0;
    const flush = async () => {
      if (!held) return;
      const data = Buffer.concat(block, held);
      block = [];
      held = 0;
      await handle.write(data);
    };
    for await (const chunk of res.body) {
      arm();
      block.push(chunk);
      held += chunk.length;
      done += chunk.length;
      if (held >= BLOCK) await flush();
      if (Date.now() - last > 250) {
        last = Date.now();
        onProgress?.(done, total);
      }
    }
    await flush();
    onProgress?.(done, total);
    if (total && done < total) throw new Error("The connection dropped before the download finished.");
    if (total && done > total) {
      fs.rmSync(part, { force: true });
      throw new Error("The download came out bigger than the file. Starting it again.");
    }
  } catch (e) {
    // A full or read-only disk won't fix itself by trying again.
    if (["ENOSPC", "EROFS", "EACCES", "EPERM"].includes(e?.code)) throw new Fatal(e.message, { cause: e });
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    await handle?.close().catch(() => {});
  }
}

async function sha256(file, signal) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function anySignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// While anything downloads, the computer doesn't fall asleep on its own (a sleeping
// computer drops the connection). It can still sleep when the lid closes.
let downloads = 0;
let blocker = null;

function keepAwake() {
  if (downloads++ === 0) {
    try {
      // Both end on their own if this app quits or crashes, so sleep is never blocked for good.
      blocker = IS_MAC
        ? spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
        : spawn(
            "systemd-inhibit",
            ["--what=idle", "--who=Liquid Agent", "--why=Downloading a model", "--mode=block", "sh", "-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 20; done`],
            { stdio: "ignore", detached: true },
          );
      blocker.on("error", () => (blocker = null));
      blocker.unref();
    } catch {
      blocker = null;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--downloads === 0 && blocker) {
      try {
        // The Linux one is a group (systemd-inhibit and its shell): end both.
        if (IS_MAC) blocker.kill();
        else process.kill(-blocker.pid);
      } catch {}
      blocker = null;
    }
  };
}
