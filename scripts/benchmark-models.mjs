#!/usr/bin/env node
// Opt-in benchmark of a running local Liquid Agent instance. Never changes its settings or models.
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import WebSocket from "ws";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
if (args.includes("--help")) {
  console.log("Usage: node scripts/benchmark-models.mjs [--url http://127.0.0.1:8170] [--mode tts|chat|both|concurrent|asr] [--audio input.wav] [--turns 10] [--lang es] [--voice female] [--interval-ms 1000] [--keep-chat]\nConcurrent mode runs chat and TTS together. ASR mode requires --audio and uses the saved dictation language. Prints JSON to stdout. Runs real inference, creates and normally deletes one benchmark chat. Audio latency is complete-clip latency, not time to first audio. Memory values are sampled server and direct-child PSS, not system or GPU peaks.");
  process.exit(0);
}
const base = new URL(option("--url", "http://127.0.0.1:8170"));
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("The URL must be a plain local HTTP origin.");
const origin = base.origin;
const mode = option("--mode", "both");
const turns = Number(option("--turns", "10"));
const interval = Number(option("--interval-ms", "1000"));
const lang = option("--lang", "es");
const voice = option("--voice", "female");
if (!["tts", "chat", "both", "concurrent", "asr"].includes(mode) || !Number.isInteger(turns) || turns < 1 || turns > 1000 || !Number.isInteger(interval) || interval < 250 || interval > 60000 || !["female", "male"].includes(voice) || !["en", "en-gb", "es", "pt", "fr", "de", "it", "ja", "zh"].includes(lang)) throw new Error("Invalid benchmark options; see --help.");
const audioPath = option("--audio", null);
if (mode === "asr" && !audioPath) throw new Error("ASR mode requires --audio.");
async function readAudio(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > 25 * 1024 * 1024) throw new Error("ASR input must be a regular file between 1 byte and 25 MiB.");
    // Read at most the declared size plus one byte, even if the file grows during the read.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("ASR input changed while it was being read.");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}
const audioInput = mode === "asr" ? await readAudio(audioPath) : null;

function distribution(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const at = (q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { count: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1) };
}
const page = await fetch(origin, { redirect: "error", signal: AbortSignal.timeout(10000) });
if (!page.ok) throw new Error(`App page returned HTTP ${page.status}`);
const token = (await page.text()).match(/name="liquid-token" content="([^"]+)"/)?.[1];
if (!token) throw new Error("Could not obtain the local app token.");
async function call(method, path, body, timeout = 600000) {
  const response = await fetch(origin + path, { method, redirect: "error", headers: { "x-liquid-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}
const state = await (await call("GET", "/api/state")).json();
const selected = state.parts.filter(p => ["small","omni","guardian","browser"].includes(p.id)).map(p => ({id:p.id,status:p.status,quant:p.quant}));
let ws;
let chatId;
let pending;
const latencies = { firstTextMs: [], chatCompleteMs: [], ttsCompleteMs: [], asrCompleteMs: [] };
const transcriptLengths = [];
const samples = [];
let sampler;
let sampling = null;
let failure = null;
function sample() {
  if (sampling) return sampling;
  sampling = (async () => {
    try {
      const snapshot = await (await call("GET", "/api/diagnostics", undefined, 5000)).json();
      samples.push({ atMs: Math.round(performance.now() - started), system: snapshot.system, processes: snapshot.processes });
    } catch (error) { samples.push({ atMs: Math.round(performance.now() - started), error: String(error) }); }
  })().finally(() => { sampling = null; });
  return sampling;
}
const started = performance.now();
try {
  await sample();
  sampler = setInterval(() => { void sample(); }, interval);
  if (["chat", "both", "concurrent"].includes(mode)) {
    ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?t=${encodeURIComponent(token)}`, { origin });
    await once(ws, "open");
    const chat = await (await call("POST", "/api/chats", {})).json();
    chatId = chat.id;
    ws.on("message", bytes => {
      if (!pending) return;
      let event; try { event = JSON.parse(bytes.toString()); } catch { return; }
      if (event.type === "delta" && event.chatId === chatId && typeof event.messageId === "string" && event.messageId !== pending.previous && pending.first === null && typeof event.text === "string" && event.text.length) {
        pending.first = performance.now() - pending.start;
      }
      if (event.type !== "chat" || event.chat?.id !== chatId) return;
      const last = event.chat.messages?.at(-1);
      if (last?.role !== "assistant" || last.id === pending.previous) return;
      if (pending.first === null && typeof last.content === "string" && last.content.length) pending.first = performance.now() - pending.start;
      if (["done", "error", "stopped"].includes(last.status)) {
        const finished = pending; pending = null;
        if (last.status === "done") finished.resolve({first:finished.first, elapsed:performance.now()-finished.start, id:last.id});
        else finished.reject(new Error(`Chat ended with status ${last.status}`));
      }
    });
  }
  let previous = null;
  for (let i = 0; i < turns; i++) {
    const runChat = async () => {
      const start = performance.now();
      let timer;
      const answer = new Promise((resolve,reject) => { pending = {start, first:null, previous, resolve, reject}; timer = setTimeout(() => { pending = null; reject(new Error("Chat timed out")); }, 600000); });
      try {
        const [, result] = await Promise.all([call("POST", `/api/chats/${chatId}/send`, {text:"Describe a pleasant spring morning in one short sentence."}), answer]);
        previous = result.id;
        if (result.first != null) latencies.firstTextMs.push(result.first);
        latencies.chatCompleteMs.push(result.elapsed);
      } finally { clearTimeout(timer); pending = null; }
    };
    const runSpeech = async () => {
      const phrases = {en:"Hello. Today is a pleasant and peaceful day.", "en-gb":"Hello. Today is a pleasant and peaceful day.", es:"Buenos días. Hoy hace un día agradable y tranquilo.", pt:"Bom dia. Hoje é um dia agradável e tranquilo.", fr:"Bonjour. Aujourd’hui, la journée est agréable et calme.", de:"Guten Tag. Heute ist ein angenehmer und ruhiger Tag.", it:"Buongiorno. Oggi è una giornata piacevole e tranquilla.", ja:"おはようございます。今日は穏やかで気持ちのよい日です。", zh:"你好。今天是舒适而平静的一天。"};
      const text = phrases[lang];
      const start = performance.now();
      const res = await call("POST", "/api/speak", { text, lang, voice });
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength) throw new Error("Speech returned an empty response");
      latencies.ttsCompleteMs.push(performance.now() - start);
    };
    if (mode === "concurrent") {
      const outcomes = await Promise.allSettled([runChat(), runSpeech()]);
      const failed = outcomes.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    } else {
      if (mode === "chat" || mode === "both") await runChat();
      if (mode === "tts" || mode === "both") await runSpeech();
    }
    if (mode === "asr") {
      const start = performance.now();
      const response = await fetch(origin + "/api/transcribe", { method: "POST", redirect: "error", headers: { "x-liquid-token": token, "content-type": "audio/wav" }, body: audioInput, signal: AbortSignal.timeout(600000) });
      if (!response.ok) throw new Error(`/api/transcribe: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const result = await response.json();
      if (typeof result.text !== "string") throw new Error("Dictation returned an invalid transcript.");
      latencies.asrCompleteMs.push(performance.now() - start);
      transcriptLengths.push([...result.text].length);
    }
  }
} catch (error) {
  failure = String(error);
} finally {
  clearInterval(sampler);
  await sample();
  if (chatId && !args.includes("--keep-chat")) await call("DELETE", `/api/chats/${chatId}`).catch(error => console.error(`Could not remove benchmark chat ${chatId}: ${error}`));
  ws?.close();
}
const sampledTotals = samples.map(s => {
  const processes = Object.entries(s.processes ?? {}).filter(([id]) => id !== "server").map(([, process]) => process);
  const valid = processes.filter(p => typeof p.pssBytes === "number");
  return valid.length && valid.length === processes.length ? valid.reduce((n,p) => n+p.pssBytes, 0) : null;
}).filter(n => n !== null);
const managedTotals = samples.map(s => {
  const processes = Object.values(s.processes ?? {});
  if (typeof s.processes?.server?.pssBytes !== "number" || processes.some(p => typeof p.pssBytes !== "number")) return null;
  return processes.reduce((sum, p) => sum + p.pssBytes, 0);
}).filter(n => n !== null);
console.log(JSON.stringify({ timestamp: new Date().toISOString(), status:failure ? "failed" : "completed", error:failure, mode, turns, lang, voice, intervalMs:interval, audioInputBytes:audioInput?.length ?? null, transcriptCharacters:distribution(transcriptLengths), benchmarkChatId:args.includes("--keep-chat") ? chatId ?? null : null, models:selected, settings:{modelContext:state.settings.modelContext, omniSlots:state.settings.omniSlots, startupMode:state.settings.startupMode, promptCacheMiB:state.settings.promptCacheMiB, idleSleepMinutes:state.settings.idleSleepMinutes, gpuLayers:state.settings.gpuLayers, omniProjector:state.settings.omniProjector, verifySpeech:state.settings.verifySpeech, asrLanguage:state.settings.asrLanguage}, latenciesMs:Object.fromEntries(Object.entries(latencies).map(([k,v]) => [k,distribution(v)])), sampledDirectChildPssBytes:distribution(sampledTotals), sampledManagedPssBytes:distribution(managedTotals), samples, limitations:["Sampled values can miss peaks and exclude browser subprocesses and GPU allocations.","TTS is complete-clip latency; this API does not stream first audio.","First text is observed over WebSocket and includes transport and event handling.","ASR uses the saved dictation language; transcript length does not measure accuracy.","This is not a speech quality or accent test."] }, null, 2));
if (failure) process.exitCode = 1;
