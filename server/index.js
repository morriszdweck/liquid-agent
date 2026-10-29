// Liquid Agent's local web server. Serves the web UI and its API on
// 127.0.0.1 only, and runs the agent, the models and the voice bridge.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { DATA, ROOT, bus, flushAll, settings, updateSettings } from "./core.js";
import { backends } from "./backends.js";
import { agent } from "./agent.js";
import { memory } from "./memory.js";
import { routineStore } from "./routines.js";
import { cancelReminder, reminderList } from "./tools.js";
import { MAX_UPLOAD, uploads } from "./uploads.js";
import { speak, transcribe } from "./omni.js";
import { handleVoice } from "./voice.js";

const PORT = Number(process.env.LIQUID_AGENT_PORT ?? 8170);
const HOST = "127.0.0.1";
const TOKEN = crypto.randomBytes(24).toString("hex");
const DIST = path.join(ROOT, "web", "dist");
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Request helpers ----

async function body(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "That file is too big (25 MB at most).");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function json(req) {
  const raw = await body(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Bad JSON.");
  }
}

function send(res, status, value) {
  const text = JSON.stringify(value ?? { ok: true });
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(text);
}

/** Blocks other websites (and DNS rebinding) from talking to this server. */
function trusted(req, url, { needToken }) {
  if (!HOSTS.has(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return false;
  if (!needToken) return true;
  const token = req.headers["x-liquid-token"] ?? url.searchParams.get("t");
  return typeof token === "string" && token.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN));
}

function snapshot() {
  return {
    chats: agent.chats,
    running: agent.running,
    settings,
    parts: backends.snapshot(),
    busy: backends.busy,
    guardianWanted: backends.guardianWanted,
    machine: backends.machine,
    memory: memory.facts,
    ideas: memory.ideas,
    routines: routineStore.list,
    activity: agent.activity.slice(0, 200),
    reminders: reminderList(),
    dataDir: DATA,
  };
}

// ---- API ----

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });

route("GET", "/api/state", () => snapshot());

route("POST", "/api/chats", async (req) => {
  const { text, attachments } = await json(req);
  if (text || attachments?.length) return agent.send(null, { text, attachments });
  return agent.create();
});
route("PATCH", "/api/chats/([\\w-]+)", async (req, [id]) => agent.update(id, await json(req)) ?? notFound());
route("DELETE", "/api/chats/([\\w-]+)", (_, [id]) => agent.remove(id));
route("DELETE", "/api/chats", () => agent.removeAll());
route("POST", "/api/chats/([\\w-]+)/send", async (req, [id]) => {
  if (!agent.chat(id)) notFound();
  return agent.send(id, await json(req));
});
route("POST", "/api/chats/([\\w-]+)/edit", async (req, [id]) => {
  const { messageId, text } = await json(req);
  return agent.edit(id, messageId, text) ?? notFound();
});
route("POST", "/api/chats/([\\w-]+)/regenerate", (_, [id]) => agent.regenerate(id) ?? notFound());
route("POST", "/api/chats/([\\w-]+)/stop", (_, [id]) => agent.stop(id));
route("POST", "/api/approvals/([\\w-]+)", async (req, [id]) => {
  const { approve } = await json(req);
  if (!agent.approve(id, approve)) notFound();
});

route("POST", "/api/uploads", async (req) => {
  const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
  const data = await body(req, MAX_UPLOAD);
  try {
    return await uploads.add(name, String(req.headers["content-type"] ?? ""), data);
  } catch {
    throw new HttpError(415, "I couldn't read that file.");
  }
});

route("POST", "/api/transcribe", async (req) => {
  const wav = await body(req, MAX_UPLOAD);
  if (!backends.running("omni")) throw new HttpError(503, "Dictation needs Eyes and ears (LFM3 Omni 2B).");
  return { text: await transcribe(wav) };
});

route("POST", "/api/speak", async (req, _, res) => {
  const { text, voice } = await json(req);
  if (!backends.running("omni")) throw new HttpError(503, "Reading aloud needs Eyes and ears (LFM3 Omni 2B).");
  const audio = await speak(String(text ?? "").slice(0, 1200), voice === "male" ? "male" : voice === "female" ? "female" : settings.voice);
  res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length, "Cache-Control": "no-store" });
  res.end(audio);
  return undefined;
});

route("GET", "/api/settings", () => settings);
// Approve for Me needs Auto 200M. Choosing it early fetches Auto 200M and turns the mode on once it's ready.
route("PATCH", "/api/settings", async (req) => {
  const patch = (await json(req)) ?? {};
  const before = { small: settings.smallQuant, omni: settings.omniQuant };
  const resizing = ["small", "omni"].some((id) => `${id}Quant` in patch && patch[`${id}Quant`] !== before[id]);
  if (resizing && backends.busy) throw new HttpError(409, "Wait for the current download to finish, then pick a size.");
  if (patch.approvalMode === "approveForMe" && !backends.running("guardian")) {
    delete patch.approvalMode;
    backends.wantGuardian(true);
    backends.install(["guardian"]);
  } else if ("approvalMode" in patch && backends.guardianWanted) {
    backends.wantGuardian(false);
  }
  const next = updateSettings(patch);
  for (const id of ["small", "omni"]) if (settings[`${id}Quant`] !== before[id]) backends.switchQuant(id);
  return next;
});
backends.readyHooks.push((id) => {
  if (id !== "guardian" || !backends.guardianWanted) return;
  backends.wantGuardian(false);
  updateSettings({ approvalMode: "approveForMe" });
});

route("POST", "/api/memory", async (req) => {
  const { fact } = await json(req);
  memory.add(fact);
  return memory.facts;
});
route("PATCH", "/api/memory/(\\d+)", async (req, [i]) => {
  memory.update(Number(i), (await json(req)).fact);
  return memory.facts;
});
route("DELETE", "/api/memory/(\\d+)", (_, [i]) => {
  memory.remove(Number(i));
  return memory.facts;
});
route("DELETE", "/api/memory", () => memory.clear());
route("POST", "/api/ideas/refresh", async () => {
  if (!backends.running("small")) throw new HttpError(503, "Ideas need the Everyday brain (LFM3 1.7B).");
  return memory.refreshIdeas();
});

route("POST", "/api/routines", async (req) => {
  try {
    return routineStore.create(await json(req));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});
route("PATCH", "/api/routines/([\\w-]+)", async (req, [id]) => routineStore.update(id, await json(req)) ?? notFound());
route("DELETE", "/api/routines/([\\w-]+)", (_, [id]) => routineStore.remove(id));
route("POST", "/api/routines/([\\w-]+)/run", (_, [id]) => routineStore.run(id) ?? notFound());

route("DELETE", "/api/reminders/([\\w-]+)", (_, [id]) => cancelReminder(id));
route("DELETE", "/api/activity", () => agent.clearActivity());

route("POST", "/api/parts/install", async (req) => {
  const { ids } = await json(req);
  backends.install(Array.isArray(ids) ? ids : []);
});
route("POST", "/api/parts/cancel", () => backends.cancel());
route("POST", "/api/parts/(\\w+)/remove", (_, [id]) => {
  backends.remove(id);
  if (id === "guardian" && settings.approvalMode === "approveForMe") updateSettings({ approvalMode: "askAlways" });
});
route("POST", "/api/parts/(\\w+)/start", (_, [id]) => {
  backends.start(id);
});
route("POST", "/api/parts/(\\w+)/stop", (_, [id]) => backends.stop(id));
route("POST", "/api/reveal", async () => {
  spawn("open", [DATA]).on("error", () => {});
});

function notFound() {
  throw new HttpError(404, "Not found.");
}

async function api(req, res, url) {
  // Attachments are shown with <img src>, so they take the token from the query string.
  const file = url.pathname.match(/^\/api\/uploads\/([\w-]+)$/);
  if (file && req.method === "GET") {
    const u = uploads.get(file[1]);
    const p = uploads.file(file[1]);
    if (!u || !p) return send(res, 404, { error: "Not found." });
    res.writeHead(200, { "Content-Type": u.mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
    return fs.createReadStream(p).pipe(res);
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const result = await r.handler(req, m.slice(1), res);
    if (!res.headersSent) send(res, 200, result);
    return;
  }
  send(res, 404, { error: "Not found." });
}

// ---- Static web UI ----

function serveStatic(res, url) {
  let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) return send(res, 403, { error: "Forbidden." });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    return res.end("The web UI isn't built yet. Run: npm run build");
  }
  const ext = path.extname(file);
  const headers = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (ext === ".html") {
    const html = fs.readFileSync(file, "utf8").replace("</head>", `<meta name="liquid-token" content="${TOKEN}"></head>`);
    res.writeHead(200, {
      ...headers,
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; worker-src 'self' blob:; frame-ancestors 'none'",
    });
    return res.end(html);
  }
  res.writeHead(200, { ...headers, "Cache-Control": url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// ---- Server ----

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/healthz") return send(res, 200, { app: "liquid-agent" });
  const isApi = url.pathname.startsWith("/api/");
  if (!trusted(req, url, { needToken: isApi })) return send(res, isApi ? 401 : 403, { error: "Not allowed." });
  try {
    if (isApi) await api(req, res, url);
    else serveStatic(res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    send(res, e.status ?? 500, { error: e.status ? e.message : String(e?.message ?? e).slice(0, 300) });
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!["/ws", "/voice"].includes(url.pathname) || !req.headers.origin || !trusted(req, url, { needToken: true })) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/voice") return handleVoice(ws);
    bus.add(ws);
    ws.send(JSON.stringify({ type: "hello", ...snapshot() }));
  });
});

function openBrowser() {
  const url = `http://127.0.0.1:${PORT}`;
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

server.on("error", async (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  // Already running? Then just open it.
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if ((await res.json()).app === "liquid-agent") {
      console.log(`Liquid Agent is already running at http://127.0.0.1:${PORT}`);
      if (process.argv.includes("--open")) openBrowser();
      process.exit(0);
    }
  } catch {}
  console.error(`Port ${PORT} is in use by another program. Set LIQUID_AGENT_PORT to use a different port.`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Liquid Agent is running at http://127.0.0.1:${PORT}`);
  console.log(`Data: ${DATA}`);
  if (process.argv.includes("--open")) openBrowser();
  if (settings.approvalMode === "approveForMe" && !backends.installed("guardian")) updateSettings({ approvalMode: "askAlways" });
  backends
    .startAll()
    .catch(() => {})
    .finally(() => backends.resume());
  memory.tidy();
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  backends.stopAll();
  flushAll();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.on("exit", () => backends.stopAll());
