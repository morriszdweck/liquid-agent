// Remote control: use this Liquid Agent from liquid-rc.mincoffical.codes on any phone or computer.
//
// Liquid Agent keeps listening on 127.0.0.1 only. When remote control is on, it dials out
// to a relay and passes requests from paired browsers to its own local server.
// Everything is end-to-end encrypted with AES-256-GCM under a key that only
// travels in the pairing link's #fragment, which browsers never send to a
// server. The relay sees a room id and ciphertext, nothing else.
//
// Relay frames (JSON text):
//   relay → host   {ev:"join"|"leave", c}   a browser joined or left the room
//   browser → host {c, d}                    d = encrypted message (relay adds c)
//   host → browser {c, d} | {c:"*", d}       (relay strips c)
//   host → browser {c, x:"bad-key"}          the browser holds an old key
// Encrypted messages: {t:"req"|"res"|"open"|"opened"|"ev"|"send"|"shut"|"ping"|"pong", …}
// Sockets carry text as `data` and binary (voice audio) as base64url `bin`.

import crypto from "node:crypto";
import WebSocket from "ws";
import { bus, load, save } from "./core.js";

const RELAY = process.env.LIQUID_AGENT_RELAY ?? "wss://liquid-rc.mincoffical.codes/relay";
const SITE = process.env.LIQUID_AGENT_RC_SITE ?? "https://liquid-rc.mincoffical.codes";
const CHUNK = 192 * 1024;
const MAX_BODY = 30 * 1024 * 1024;

let state = load("remote.json", { enabled: false, key: "" });
let relay = null;
let status = "off"; // off | connecting | online
let retry = 0;
let timer = null;
let local = { port: 0, token: "" };
/** Browsers that proved they hold the key, by relay client id. */
const peers = new Map();

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const newKey = () => b64u(crypto.randomBytes(32));
const keyBytes = () => Buffer.from(state.key, "base64url");

/** The relay room is a hash of the key, so the link only has to carry the key. */
export const roomOf = (key) => crypto.createHash("sha256").update(`liquid-rc-room:${key}`).digest("base64url").slice(0, 32);

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  c.setAAD(Buffer.from("h2c"));
  const out = Buffer.concat([iv, c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return out.toString("base64url");
}

function open(d) {
  const raw = Buffer.from(d, "base64url");
  if (raw.length < 29) throw new Error("short");
  const c = crypto.createDecipheriv("aes-256-gcm", keyBytes(), raw.subarray(0, 12));
  c.setAAD(Buffer.from("c2h"));
  c.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([c.update(raw.subarray(12, raw.length - 16)), c.final()]).toString("utf8"));
}

export function info() {
  return {
    enabled: state.enabled,
    status,
    link: state.key ? `${SITE}/#k=${state.key}` : "",
    devices: [...peers.values()].filter((p) => p.ok).length,
  };
}

const announce = () => bus.emit("remote", { remote: info() });

function setStatus(next) {
  if (status === next) return;
  status = next;
  announce();
}

/** index.js hands over its port and per-launch token so requests can go to the local server. */
export function startRemote(port, token) {
  local = { port, token };
  if (state.enabled && state.key) connect();
}

export function setRemote(enabled) {
  state = { ...state, enabled: Boolean(enabled), key: state.key || newKey() };
  save("remote.json", state);
  if (state.enabled) connect();
  else disconnect();
  announce();
  return info();
}

/** A new link. Browsers paired with the old one stop working. */
export function resetRemote() {
  state = { ...state, key: newKey() };
  save("remote.json", state);
  if (state.enabled) {
    disconnect();
    connect();
  }
  announce();
  return info();
}

function disconnect() {
  clearTimeout(timer);
  timer = null;
  for (const id of [...peers.keys()]) dropPeer(id);
  if (relay) {
    relay.removeAllListeners();
    relay.on("error", () => {});
    relay.terminate();
    relay = null;
  }
  setStatus("off");
}

function connect() {
  disconnect();
  setStatus("connecting");
  const ws = new WebSocket(`${RELAY}?role=host&room=${roomOf(state.key)}`, { handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024 });
  relay = ws;
  let alive = true;
  const beat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);
  ws.on("pong", () => (alive = true));
  ws.on("ping", () => (alive = true));
  ws.on("open", () => {
    retry = 0;
    setStatus("online");
  });
  ws.on("message", (data) => {
    alive = true;
    let f;
    try {
      f = JSON.parse(String(data));
    } catch {
      return;
    }
    onFrame(f);
  });
  ws.on("error", () => {});
  ws.on("close", () => {
    clearInterval(beat);
    if (relay !== ws) return;
    relay = null;
    for (const id of [...peers.keys()]) dropPeer(id);
    if (!state.enabled) return setStatus("off");
    setStatus("connecting");
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(connect, 1000 * 2 ** retry);
  });
}

function sendFrame(f) {
  if (relay?.readyState === WebSocket.OPEN) relay.send(JSON.stringify(f));
}

/** Encrypts and sends, splitting big messages so no relay frame gets large. */
function toPeer(c, msg) {
  const d = seal(msg);
  if (d.length <= CHUNK) return sendFrame({ c, d });
  const id = crypto.randomBytes(6).toString("hex");
  const n = Math.ceil(d.length / CHUNK);
  for (let i = 0; i < n; i++) sendFrame({ c, d: d.slice(i * CHUNK, (i + 1) * CHUNK), m: id, i, n });
}

function peer(c) {
  let p = peers.get(c);
  if (!p) peers.set(c, (p = { ok: false, sockets: new Map(), parts: new Map() }));
  return p;
}

function dropPeer(c) {
  const p = peers.get(c);
  if (!p) return;
  for (const s of p.sockets.values()) s.terminate();
  peers.delete(c);
  if (p.ok) announce();
}

function onFrame(f) {
  if (f.ev === "join") return void peer(f.c);
  if (f.ev === "leave") return dropPeer(f.c);
  if (typeof f.c !== "string" || typeof f.d !== "string") return;
  const p = peer(f.c);
  let d = f.d;
  if (f.m) {
    // A chunk of a big message (an upload, say).
    if (!(Number.isInteger(f.i) && Number.isInteger(f.n) && f.i >= 0 && f.i < f.n && f.n <= Math.ceil((MAX_BODY * 1.4) / CHUNK) + 1)) return;
    if (!p.parts.has(f.m) && p.parts.size >= 8) return;
    const buf = p.parts.get(f.m) ?? [];
    buf[f.i] = d;
    p.parts.set(f.m, buf);
    if (buf.filter(Boolean).length < f.n) return;
    p.parts.delete(f.m);
    d = buf.join("");
    if (d.length > MAX_BODY * 1.4) return;
  }
  let msg;
  try {
    msg = open(d);
  } catch {
    return sendFrame({ c: f.c, x: "bad-key" });
  }
  if (!p.ok) {
    p.ok = true;
    announce();
  }
  handle(f.c, p, msg).catch(() => {});
}

/** The local sockets a paired browser may open. */
const SOCKETS = new Set(["/ws", "/voice"]);

/** Paths a paired browser may not use: it can't turn remote control off or change the link from afar. */
const BLOCKED = /^\/api\/remote(\/|$)/;

async function handle(c, p, msg) {
  if (msg.t === "ping") return toPeer(c, { t: "pong" });
  if (msg.t === "req") {
    const path = String(msg.p ?? "/");
    if (!path.startsWith("/") || path.startsWith("//")) return toPeer(c, { t: "res", id: msg.id, s: 400, h: {}, b: "" });
    const method = String(msg.m ?? "GET").toUpperCase();
    if (BLOCKED.test(path) && method !== "GET") {
      return toPeer(c, { t: "res", id: msg.id, s: 403, h: { "content-type": "application/json" }, b: b64u(JSON.stringify({ error: "Change remote control on the computer itself." })) });
    }
    const headers = {};
    for (const [k, v] of Object.entries(msg.h ?? {})) if (/^(content-type|x-file-name|accept)$/i.test(k)) headers[k] = String(v);
    headers["X-Liquid-Token"] = local.token;
    try {
      const res = await fetch(`http://127.0.0.1:${local.port}${path}`, {
        method,
        headers,
        body: msg.b && method !== "GET" && method !== "HEAD" ? Buffer.from(msg.b, "base64url") : undefined,
        signal: AbortSignal.timeout(600_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      toPeer(c, { t: "res", id: msg.id, s: res.status, h: { "content-type": res.headers.get("content-type") ?? "" }, b: b64u(body) });
    } catch (e) {
      toPeer(c, { t: "res", id: msg.id, s: 502, h: { "content-type": "application/json" }, b: b64u(JSON.stringify({ error: `Liquid Agent didn't answer: ${e.message}` })) });
    }
    return;
  }
  if (msg.t === "open") {
    // The app's live updates (/ws) and voice chat (/voice): one local socket per remote one.
    const sid = String(msg.s);
    const path = SOCKETS.has(msg.p) ? msg.p : "/ws";
    p.sockets.get(sid)?.terminate();
    if (p.sockets.size >= 8) return toPeer(c, { t: "shut", s: sid });
    const ws = new WebSocket(`ws://127.0.0.1:${local.port}${path}?t=${local.token}`, { origin: `http://127.0.0.1:${local.port}` });
    p.sockets.set(sid, ws);
    ws.on("open", () => toPeer(c, { t: "opened", s: sid }));
    ws.on("message", (data, isBinary) => toPeer(c, isBinary ? { t: "ev", s: sid, bin: b64u(data) } : { t: "ev", s: sid, data: String(data) }));
    ws.on("error", () => {});
    ws.on("close", () => {
      if (p.sockets.get(sid) !== ws) return;
      p.sockets.delete(sid);
      toPeer(c, { t: "shut", s: sid });
    });
    return;
  }
  if (msg.t === "send") {
    const ws = p.sockets.get(String(msg.s));
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (typeof msg.bin === "string") ws.send(Buffer.from(msg.bin, "base64url"), { binary: true });
    else if (typeof msg.data === "string") ws.send(msg.data);
    return;
  }
  if (msg.t === "shut") {
    const ws = p.sockets.get(String(msg.s));
    p.sockets.delete(String(msg.s));
    ws?.terminate();
  }
}
