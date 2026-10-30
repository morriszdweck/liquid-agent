// Starts the server with an empty data folder and checks that its API works.
//
//   node scripts/smoke.mjs            the server, its page and the API
//   node scripts/smoke.mjs --models   also downloads the AI engine and the smallest
//                                     LFM3 1.7B, then has it answer (about 1.1 GB)
//   node scripts/smoke.mjs --omni     also downloads the smallest LFM3 Omni 2B, then
//                                     has it speak, listen and look at a picture (1.6 GB)
//   node scripts/smoke.mjs --helpers  also installs and starts Auto 200M and the
//                                     Web helper (about 1.2 GB)
//
// Uses its own port and data folder, so a copy of Liquid Agent that is already
// running is left alone.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 8199);
const BASE = `http://127.0.0.1:${PORT}`;
const MODELS = process.argv.includes("--models");
const HELPERS = process.argv.includes("--helpers");
const OMNI = process.argv.includes("--omni");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-agent-smoke-"));

const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  env: { ...process.env, LIQUID_AGENT_HOME: home, LIQUID_AGENT_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = "";

function finish(code) {
  server.kill("SIGTERM");
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(code);
}

function fail(message) {
  console.error(`✗ ${message}\n--- server output ---\n${log.slice(-4000)}`);
  for (const name of ["small.log", "omni.log", "guardian.log", "browser.log"]) {
    const file = path.join(home, "logs", name);
    if (fs.existsSync(file)) console.error(`--- ${name} ---\n${fs.readFileSync(file, "utf8").slice(-3000)}`);
  }
  finish(1);
}

function check(ok, message) {
  if (!ok) fail(message);
  console.log(`✓ ${message}`);
}

/** Sends raw bytes and returns the response, for uploads and audio. */
async function send(route, data, type, headers = {}) {
  const res = await fetch(BASE + route, { method: "POST", headers: { "x-liquid-token": token, "Content-Type": type, ...headers }, body: data });
  if (!res.ok) fail(`POST ${route} answered ${res.status}: ${await res.text()}`);
  return res;
}

/** A plain PNG of one color, so the picture check needs no files. */
function solidPNG(size, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

/** Waits for the last message of a chat to finish. */
const answer = (id, what) =>
  waitFor(
    what,
    (s) => {
      const last = s.chats.find((c) => c.id === id)?.messages.at(-1);
      return last?.role === "assistant" && last.status !== "streaming" && last;
    },
    10,
  );

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { "x-liquid-token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json().catch(() => null);
  if (!res.ok) fail(`${method} ${route} answered ${res.status}: ${JSON.stringify(value)}`);
  return value;
}

/** Polls the state until `test` returns something truthy. */
async function waitFor(what, test, minutes) {
  const until = Date.now() + minutes * 60_000;
  let last = 0;
  while (Date.now() < until) {
    const state = await call("GET", "/api/state");
    const found = test(state);
    if (found) return found;
    const failed = state.parts.find((p) => p.status === "failed");
    if (failed) fail(`${failed.id} failed: ${failed.error}`);
    if (Date.now() - last > 30_000) {
      last = Date.now();
      console.log(`  waiting for ${what}… ${state.parts.map((p) => `${p.id}=${p.status}${p.text ? ` (${p.text})` : ""}`).join(" ")}`);
    }
    await sleep(2000);
  }
  fail(`timed out waiting for ${what}`);
}

server.on("exit", (code) => fail(`the server exited with ${code}`));
process.on("SIGINT", () => finish(130));

for (let i = 0; ; i++) {
  try {
    const health = await (await fetch(`${BASE}/healthz`)).json();
    if (health.app === "liquid-agent") break;
  } catch {}
  if (i > 60) fail("the server didn't start");
  await sleep(500);
}
check(true, `server answers on ${BASE}`);

const page = await (await fetch(BASE + "/")).text();
token = page.match(/name="liquid-token" content="([^"]+)"/)?.[1] ?? "";
check(token.length > 0, "the page carries a token");

const refused = await fetch(BASE + "/api/state");
check(refused.status === 401, "the API refuses requests without the token");

const foreign = await fetch(BASE + "/api/state", { headers: { "x-liquid-token": token, Origin: "https://example.com" } });
check(foreign.status === 401, "the API refuses other websites");

const state = await call("GET", "/api/state");
check(state.machine.os === process.platform, `it knows this is ${process.platform} (engine build: ${state.machine.gpu})`);
const ids = state.parts.map((p) => p.id);
check(["engine", "small", "omni", "guardian", "browser"].every((id) => ids.includes(id)), "every part is listed");
check(state.dataDir === home, "it keeps its files in the data folder it was given");
check(state.routines.length > 0, "starter routines are there");

if (MODELS) {
  await call("PATCH", "/api/settings", { smallQuant: "QAD-Q4_0" });
  await call("POST", "/api/parts/install", { ids: ["engine", "small"] });
  await waitFor("LFM3 1.7B", (s) => s.parts.find((p) => p.id === "small" && p.status === "running"), 30);
  const engine = (await call("GET", "/api/state")).parts.find((p) => p.id === "engine");
  check(true, `LFM3 1.7B runs (${engine.detail ?? "engine installed"})`);

  const chat = await call("POST", "/api/chats", { text: "Reply with one word: what color is a clear daytime sky?" });
  const reply = await answer(chat.id, "an answer");
  check(reply.status === "done" && reply.content.trim().length > 0, `LFM3 1.7B answered: ${JSON.stringify(reply.content.trim().slice(0, 80))}`);
  check(reply.model === "small", "the message went to LFM3 1.7B");

  // A small model doesn't always pick a tool, so this only fails when a tool it picked breaks.
  const tool = await call("POST", "/api/chats", { text: "Run this shell command and tell me what it prints: echo liquid-smoke-ok" });
  const lastOf = (s) => s.chats.find((c) => c.id === tool.id)?.messages.at(-1);
  const held = await waitFor(
    "the shell tool",
    (s) => {
      const last = lastOf(s);
      return last?.steps?.find((st) => st.status === "approval") ?? (last?.role === "assistant" && last.status !== "streaming" && "no tool");
    },
    10,
  );
  if (held === "no tool") {
    console.log("- it answered without a tool this time");
  } else {
    check(held.tool === "shell", `Ask for Approval held the ${held.tool} tool`);
    await call("POST", `/api/approvals/${held.id}`, { approve: true });
    const ran = await waitFor("the command", (s) => lastOf(s)?.steps?.find((st) => st.id === held.id && ["done", "error"].includes(st.status)), 5);
    check(String(ran.result).includes("liquid-smoke-ok"), `the shell tool ran the command: ${JSON.stringify(String(ran.result).trim().slice(0, 80))}`);
  }
}

if (OMNI) {
  await call("PATCH", "/api/settings", { omniQuant: "Q4_0" });
  await call("POST", "/api/parts/install", { ids: ["engine", "omni"] });
  await waitFor("LFM3 Omni 2B", (s) => s.parts.find((p) => p.id === "omni" && p.status === "running"), 40);
  check(true, "LFM3 Omni 2B runs");

  const wav = Buffer.from(await (await send("/api/speak", JSON.stringify({ text: "Hello from Linux." }), "application/json")).arrayBuffer());
  check(wav.toString("ascii", 0, 4) === "RIFF" && wav.length > 8000, `it reads text aloud (${wav.length} bytes of WAV)`);
  const heard = await (await send("/api/transcribe", wav, "audio/wav")).json();
  check(/hello|linux/i.test(heard.text), `it hears its own voice: ${JSON.stringify(heard.text)}`);

  const picture = await (await send("/api/uploads", solidPNG(64, [220, 30, 30]), "image/png", { "x-file-name": "red.png" })).json();
  check(picture.kind === "image", "a picture uploads");
  const chat = await call("POST", "/api/chats", { text: "What color is this picture? Answer with one word.", attachments: [picture.id] });
  const reply = await answer(chat.id, "Omni to look");
  check(reply.status === "done" && reply.model === "omni", `LFM3 Omni 2B looked at it: ${JSON.stringify(reply.content.trim().slice(0, 80))}`);
  check(/red/i.test(reply.content), "it saw red");
}

if (HELPERS) {
  await call("POST", "/api/parts/install", { ids: ["guardian", "browser"] });
  const running = (s, id) => s.parts.find((p) => p.id === id && p.status === "running");
  await waitFor("Auto 200M", (s) => running(s, "guardian"), 30);
  check(true, "Auto 200M runs");
  await waitFor("the Web helper", (s) => running(s, "browser"), 30);
  check(true, "the Web helper runs");
  await call("PATCH", "/api/settings", { approvalMode: "approveForMe" });
  const mode = (await call("GET", "/api/settings")).approvalMode;
  check(mode === "approveForMe", "Approve for Me turns on");
}

console.log("All good.");
finish(0);
