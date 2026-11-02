// Starts the Rust server with an empty data folder and checks that its API works.
// Migrated from scripts/smoke.mjs. The flags became environment switches:
//
//   npm test                                  the server, its page and the API
//   LIQUID_TEST_MODELS=1                      also downloads the AI engine and the smallest
//                                             LFM3 1.7B, then has it answer (about 1.1 GB)
//   LIQUID_TEST_OMNI=1                        also downloads the smallest LFM3 Omni 2B, then has
//                                             it speak, listen and look at a picture (1.6 GB)
//   LIQUID_TEST_HELPERS=1                     also installs and starts Auto 150M and the Web helper
//                                             (about 1.2 GB; LIQUID_TEST_GUARDIAN=1 for Auto 150M alone)
//
// Uses its own port and data folder, so a copy of Liquid Agent that is already running is left alone.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let PORT;
let BASE;
let GUARDIAN_PORT;
const MODELS = process.env.LIQUID_TEST_MODELS === "1";
const HELPERS = process.env.LIQUID_TEST_HELPERS === "1";
const GUARDIAN = HELPERS || process.env.LIQUID_TEST_GUARDIAN === "1";
const OMNI = process.env.LIQUID_TEST_OMNI === "1";
// The server under test: the Rust binary (cargo build -p liquid-server).
const SERVER = process.env.LIQUID_AGENT_SERVER ?? path.join(ROOT, "target", "debug", "liquid-server");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let home;
let server;
let serverExit = null;
let log = "";
let token = "";
let smallPort;
let omniPort;
let browserPort;

async function availablePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

function start() {
  const child = spawn(SERVER, [], {
    cwd: ROOT,
    env: { ...process.env, LIQUID_AGENT_HOME: home, LIQUID_AGENT_RUST_HOME: home, LIQUID_AGENT_PORT: String(PORT), LIQUID_AGENT_RUST_PORT: String(PORT), LIQUID_AGENT_SMALL_PORT: String(smallPort), LIQUID_AGENT_OMNI_PORT: String(omniPort), LIQUID_AGENT_BROWSER_PORT: String(browserPort), LIQUID_GUARDIAN_PORT: String(GUARDIAN_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("exit", (code) => (serverExit = code ?? -1));
  return child;
}

/** Explains a failure with the server's own logs, then fails the test. */
function fail(message) {
  let detail = `--- server output ---\n${log.slice(-4000)}`;
  for (const name of ["small.log", "omni.log", "guardian.log", "browser.log"]) {
    const file = path.join(home, "logs", name);
    if (fs.existsSync(file)) detail += `\n--- ${name} ---\n${fs.readFileSync(file, "utf8").slice(-3000)}`;
  }
  throw new Error(`${message}\n${detail}`);
}

async function send(route, data, type, headers = {}) {
  const res = await fetch(BASE + route, { method: "POST", headers: { "x-liquid-token": token, "Content-Type": type, ...headers }, body: data });
  if (!res.ok) fail(`POST ${route} answered ${res.status}: ${await res.text()}`);
  return res;
}

async function call(method, route, body) {
  if (serverExit !== null) fail(`the server exited with ${serverExit}`);
  const res = await fetch(BASE + route, {
    method,
    headers: { "x-liquid-token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await res.json().catch(() => null);
  if (!res.ok) fail(`${method} ${route} answered ${res.status}: ${JSON.stringify(value)}`);
  return value;
}

/** Polls the state until `test` returns something truthy, or fails when a part fails or time runs out. */
async function waitFor(what, test, minutes) {
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    const state = await call("GET", "/api/state");
    const found = test(state);
    if (found) return found;
    const failed = state.parts.find((p) => p.status === "failed");
    if (failed) fail(`${failed.id} failed: ${failed.error}`);
    await sleep(2000);
  }
  fail(`timed out waiting for ${what}`);
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

async function up() {
  for (let i = 0; ; i++) {
    if (serverExit !== null) fail(`the server exited with ${serverExit}`);
    try {
      const health = await (await fetch(`${BASE}/healthz`)).json();
      if (health.app === "liquid-agent" && health.pid === server.pid) break;
    } catch {}
    if (i > 60) fail("the server didn't start");
    await sleep(500);
  }
  const page = await (await fetch(BASE + "/")).text();
  token = page.match(/name="liquid-token" content="([^"]+)"/)?.[1] ?? "";
}

/** Stops the server the way the app's Quit does, then starts it again on the same data. */
async function restart() {
  const old = server;
  old.removeAllListeners("exit");
  await new Promise((resolve) => {
    old.once("exit", resolve);
    old.kill("SIGTERM");
  });
  serverExit = null;
  server = start();
  await up();
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-agent-smoke-"));
  const allocated = await availablePorts(5);
  PORT = Number(process.env.SMOKE_PORT ?? allocated[0]);
  BASE = `http://127.0.0.1:${PORT}`;
  GUARDIAN_PORT = Number(process.env.SMOKE_GUARDIAN_PORT ?? allocated[1]);
  [smallPort, omniPort, browserPort] = allocated.slice(2);
  if (GUARDIAN && process.env.LIQUID_GUARDIAN_FIXTURE) {
    fs.mkdirSync(path.join(home, "guardian"), { recursive: true });
    for (const file of ["config.json", "model.safetensors", "tokenizer.json"]) {
      fs.copyFileSync(path.join(process.env.LIQUID_GUARDIAN_FIXTURE, file), path.join(home, "guardian", file));
    }
  }
  server = start();
  await up();
  await call("PATCH", "/api/settings", { smallURL: `http://127.0.0.1:${smallPort}/v1`, omniURL: `http://127.0.0.1:${omniPort}/v1`, guardianURL: `http://127.0.0.1:${GUARDIAN_PORT}`, browserURL: `http://127.0.0.1:${browserPort}` });
}, 120_000);

afterAll(async () => {
  if (server && serverExit === null) {
    await new Promise((resolve) => { server.once("exit", resolve); server.kill("SIGTERM"); });
  }
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe("Rust server smoke test", () => {
  it("answers on its port with a token, and refuses requests without one", async () => {
    expect(token.length, "the page carries a token").toBeGreaterThan(0);
    const refused = await fetch(BASE + "/api/state");
    expect(refused.status, "the API refuses requests without the token").toBe(401);
    const foreign = await fetch(BASE + "/api/state", { headers: { "x-liquid-token": token, Origin: "https://example.com" } });
    expect(foreign.status, "the API refuses other websites").toBe(401);
  });

  it("lists its parts, keeps files in its data folder, and has starter routines", async () => {
    const state = await call("GET", "/api/state");
    expect(state.machine.os, `it knows this is ${process.platform}`).toBe(process.platform);
    const ids = state.parts.map((p) => p.id);
    for (const id of ["engine", "small", "omni", "guardian", "browser"]) expect(ids, `every part is listed (${id})`).toContain(id);
    expect(state.dataDir, "it keeps its files in the data folder it was given").toBe(home);
    expect(state.routines.length, "starter routines are there").toBeGreaterThan(0);
  });

  it("validates settings and rejects remote endpoints", async () => {
    const before = await call("GET", "/api/settings");
    const changed = await call("PATCH", "/api/settings", { theme: "dark", smallURL: "http://localhost@evil.example", maxSteps: "8" });
    expect(changed.theme).toBe("dark");
    expect(changed.smallURL, "the remote endpoint was refused").toBe(before.smallURL);
    expect(changed.maxSteps, "a non-number was refused").toBe(before.maxSteps);
  });

  it("validates new routines and keeps valid schedule defaults on edit", async () => {
    const routine = await call("POST", "/api/routines", { name: "  Test routine  ", prompt: "Test", schedule: { enabled: true, time: "08:00", days: [5, 1, 1, 9] } });
    expect(routine.name).toBe("Test routine");
    expect(routine.schedule.days.join(",")).toBe("1,5");
    const updated = await call("PATCH", `/api/routines/${routine.id}`, { schedule: { time: "invalid", days: [3] } });
    expect(updated.schedule.time).toBe("08:00");
    expect(updated.schedule.enabled).toBe(false);
    expect(updated.schedule.days[0]).toBe(3);
    await call("DELETE", `/api/routines/${routine.id}`);
  });

  it.skipIf(!MODELS)("LFM3 1.7B answers, and runs a shell tool only after approval", async () => {
    await call("PATCH", "/api/settings", { smallQuant: "QAD-Q4_0" });
    await call("POST", "/api/parts/install", { ids: ["engine", "small"] });
    await waitFor("LFM3 1.7B", (s) => s.parts.find((p) => p.id === "small" && p.status === "running"), 30);
    const chat = await call("POST", "/api/chats", { text: "Reply with one word: what color is a clear daytime sky?" });
    const reply = await answer(chat.id, "an answer");
    expect(reply.status).toBe("done");
    expect(reply.content.trim().length).toBeGreaterThan(0);
    expect(reply.model).toBe("small");

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
    if (held === "no tool") return; // it answered without a tool this time
    expect(held.tool, "Ask for Approval held the shell tool").toBe("shell");
    await call("POST", `/api/approvals/${held.id}`, { approve: true });
    const ran = await waitFor("the command", (s) => lastOf(s)?.steps?.find((st) => st.id === held.id && ["done", "error"].includes(st.status)), 5);
    expect(String(ran.result)).toContain("liquid-smoke-ok");
  }, 1_200_000);

  it.skipIf(!OMNI)("LFM3 Omni 2B speaks, hears its own voice, and sees a picture", async () => {
    await call("PATCH", "/api/settings", { omniQuant: "Q4_0", startupMode: "single-omni" });
    const state = await call("GET", "/api/state");
    if (["running", "starting"].includes(state.parts.find((p) => p.id === "small")?.status)) {
      await call("POST", "/api/parts/small/stop");
    }
    await call("POST", "/api/parts/install", { ids: ["engine", "omni"] });
    await waitFor("LFM3 Omni 2B installation", (s) => s.parts.find((p) => p.id === "omni" && p.status === "installed" && p.onDemand), 40);

    const wav = Buffer.from(await (await send("/api/speak", JSON.stringify({ text: "Hello from Linux." }), "application/json")).arrayBuffer());
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.length, "it reads text aloud").toBeGreaterThan(8000);
    // These requests exercise the actual model and engine with an explicit locale and both
    // supported voice parameters. Audio content and accent still require listening tests.
    for (const voice of ["female", "male"]) {
      const response = await send("/api/speak", JSON.stringify({text:"Buenos días. ¿Cómo estás?",lang:"es",voice}), "application/json");
      expect(response.headers.get("content-type")).toContain("audio/wav");
      const spanish = Buffer.from(await response.arrayBuffer());
      expect(spanish.toString("ascii", 0, 4)).toBe("RIFF");
      expect(spanish.length, `Spanish ${voice} audio`).toBeGreaterThan(8000);
    }
    const heard = await (await send("/api/transcribe", wav, "audio/wav")).json();
    expect(heard.text, "it hears its own voice").toMatch(/hello|linux/i);

    const picture = await (await send("/api/uploads", solidPNG(64, [220, 30, 30]), "image/png", { "x-file-name": "red.png" })).json();
    expect(picture.kind).toBe("image");
    const chat = await call("POST", "/api/chats", { text: "What color is this picture? Answer with one word.", attachments: [picture.id] });
    const reply = await answer(chat.id, "Omni to look");
    expect(reply.status).toBe("done");
    expect(reply.model).toBe("omni");
    expect(reply.content, "it saw red").toMatch(/red/i);
  }, 2_400_000);

  it.skipIf(!GUARDIAN)("Auto 150M classifies actions, and Approve for Me survives an upgrade", async () => {
    await call("POST", "/api/parts/install", { ids: HELPERS ? ["guardian", "browser"] : ["guardian"] });
    const running = (s, id) => s.parts.find((p) => p.id === id && p.status === "running");
    await waitFor("Auto 150M installation", (s) => s.parts.find((p) => p.id === "guardian" && p.status === "installed"), 30);
    await call("POST", "/api/parts/guardian/start");
    await waitFor("Auto 150M", (s) => running(s, "guardian"), 30);
    if (HELPERS) {
      await waitFor("the Web helper installation", (s) => s.parts.find((p) => p.id === "browser" && p.status === "installed"), 30);
      await call("POST", "/api/parts/browser/start");
      await waitFor("the Web helper", (s) => running(s, "browser"), 30);
    }

    const classified = await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "Bash", args: "ls", request: "List my files.", history: [] }),
    }).then((res) => res.json());
    expect(typeof classified.p_deny).toBe("number");
    expect(classified.p_deny).toBeGreaterThanOrEqual(0);
    expect(classified.p_deny).toBeLessThanOrEqual(1);

    await call("PATCH", "/api/settings", { approvalMode: "approveForMe" });
    expect((await call("GET", "/api/settings")).approvalMode).toBe("approveForMe");

    const marker = path.join(home, "guardian", ".ready");
    expect(fs.readFileSync(marker, "utf8")).toBe("ProCreations/auto-150m-3");
    // A copy set up with Auto 200M left an empty marker.
    fs.writeFileSync(marker, "");
    await restart();
    await waitFor("Auto 150M after an upgrade", (s) => running(s, "guardian"), 10);
    expect(fs.readFileSync(marker, "utf8"), "a copy set up with Auto 200M moves to Auto 150M").toBe("ProCreations/auto-150m-3");
    await waitFor("Approve for Me to come back", (s) => s.settings.approvalMode === "approveForMe", 1);
  }, 1_200_000);
});
