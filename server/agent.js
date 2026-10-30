// Chats and the agent loop: pick a model, stream, run tools with approval,
// repeat until the model answers.

import crypto from "node:crypto";
import { DEVICE, MODELS, bus, load, saver, settings } from "./core.js";
import { backends } from "./backends.js";
import { classify, hardDeny } from "./guardian.js";
import { complete, stream } from "./llm.js";
import { memory } from "./memory.js";
import { buildWire, systemPrompt } from "./prompt.js";
import { parseToolCall, visibleText } from "./toolparser.js";
import { activeTools, runTool, toolMap } from "./tools.js";
import { uploads } from "./uploads.js";

const uid = () => crypto.randomUUID();
const STOPS = ["<|tool_call_end|>", "</tool_call>"];
const OPEN = ["pending", "checking", "approval", "running"];

// Small models reach for tools on plain asks ("make a table", "explain X") and
// every tool signature costs prompt tokens. Offer tools only when the request
// mentions something a tool is for, or the last reply was already using them.
const TOOL_WORDS =
  /\b(files?|folders?|desktop|downloads|documents|disk|directory|open|launch|run|command|terminal|shell|install|apps?|mac|linux|computer|search|google|look ?up|web|websites?|site|online|internet|url|links?|browse|browser|click|type into|news|weather|forecast|price|stocks?|score|latest|current|today|tonight|tomorrow|yesterday|now|recent|remind|reminder|remember|forget|recall|clipboard|copy|paste|screen|screenshot|save|read|list|delete|move|rename|battery|wi-?fi|my)\b|[~/]\w|\.[a-z]{2,4}\b/i;

/** Some templates leave the thinking in the text instead of reporting it separately. */
function splitThink(text) {
  const m = text.match(/^\s*<think>([\s\S]*?)(?:<\/think>\s*|$)/);
  return m ? { thought: m[1], rest: text.slice(m[0].length) } : { thought: "", rest: text };
}

const joinThoughts = (before, now) => [before, now.trim()].filter(Boolean).join("\n\n");

function wantsTools(chat, request) {
  if (TOOL_WORDS.test(request.content ?? "")) return true;
  const prev = chat.messages.filter((m) => m.role === "assistant" && m.status !== "streaming").at(-1);
  return Boolean(prev?.steps?.length);
}

let chats = load("chats.json", []).filter((c) => c.source !== "voice" || c.messages.length);
for (const chat of chats) {
  for (const m of chat.messages) {
    if (m.status === "streaming") m.status = "stopped";
    for (const s of m.steps ?? []) if (OPEN.includes(s.status)) Object.assign(s, { status: "error", result: "Interrupted." });
  }
}
const persist = saver("chats.json", () => chats);

let activity = load("activity.v2.json", []);
const persistActivity = saver("activity.v2.json", () => activity, 1500);

const running = new Map(); // chatId -> AbortController
const approvals = new Map(); // stepId -> {resolve, chatId}

function emitChat(chat) {
  chat.updatedAt = Date.now();
  persist();
  bus.emit("chat", { chat });
}

function emitRunning() {
  bus.emit("running", { running: [...running.keys()] });
}

function provisionalTitle(text, attachments) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  return (words || attachments[0]?.name || "New chat").slice(0, 60);
}

export const agent = {
  get chats() {
    return chats;
  },
  get activity() {
    return activity;
  },
  get running() {
    return [...running.keys()];
  },

  chat(id) {
    return chats.find((c) => c.id === id) ?? null;
  },

  create({ title = "New chat", source } = {}) {
    const chat = { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), pinned: false, source, messages: [] };
    chats.unshift(chat);
    emitChat(chat);
    return chat;
  },

  update(id, { title, pinned }) {
    const chat = this.chat(id);
    if (!chat) return null;
    if (typeof title === "string" && title.trim()) Object.assign(chat, { title: title.trim().slice(0, 80), named: true });
    if (typeof pinned === "boolean") chat.pinned = pinned;
    emitChat(chat);
    return chat;
  },

  remove(id) {
    this.stop(id);
    const chat = this.chat(id);
    if (!chat) return;
    uploads.remove(chat.messages.flatMap((m) => (m.attachments ?? []).map((a) => a.id)));
    chats = chats.filter((c) => c.id !== id);
    persist();
    bus.emit("chat.deleted", { id });
  },

  removeAll() {
    for (const chat of [...chats]) this.remove(chat.id);
  },

  /** Adds the user's message and starts the reply in the background. */
  send(chatId, { text = "", attachments = [] }) {
    const chat = (chatId && this.chat(chatId)) || this.create();
    if (running.has(chat.id)) throw new Error("I'm still working on the last message.");
    const files = attachments.map((id) => uploads.public(id)).filter(Boolean);
    if (!String(text).trim() && !files.length) throw new Error("Type a message first.");
    chat.messages.push({ id: uid(), role: "user", content: String(text).trim(), attachments: files, at: Date.now() });
    if (!chat.named && chat.messages.length === 1) chat.title = provisionalTitle(text, files);
    this.respond(chat);
    return chat;
  },

  /** Replaces a user message and everything after it, then answers again. */
  edit(chatId, messageId, text) {
    const chat = this.chat(chatId);
    if (!chat || running.has(chat.id)) return null;
    const i = chat.messages.findIndex((m) => m.id === messageId && m.role === "user");
    if (i < 0) return null;
    const old = chat.messages[i];
    chat.messages = chat.messages.slice(0, i);
    chat.messages.push({ ...old, id: uid(), content: String(text).trim(), at: Date.now() });
    this.respond(chat);
    return chat;
  },

  regenerate(chatId) {
    const chat = this.chat(chatId);
    if (!chat || running.has(chat.id)) return null;
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === "assistant") chat.messages.pop();
    if (!chat.messages.length) return null;
    this.respond(chat);
    return chat;
  },

  stop(chatId) {
    running.get(chatId)?.abort();
    for (const [stepId, a] of approvals) if (a.chatId === chatId) this.approve(stepId, false);
  },

  approve(stepId, ok) {
    const pending = approvals.get(stepId);
    if (!pending) return false;
    approvals.delete(stepId);
    pending.resolve(Boolean(ok));
    return true;
  },

  /** Omni for anything it has to see or hear; the faster 1.7B for everything else. */
  route(chat) {
    const recent = chat.messages.filter((m) => m.role === "user").slice(-2);
    const media = recent.some((m) => m.attachments?.some((a) => a.kind === "image" || a.kind === "audio"));
    const up = (id) => backends.running(id);
    if (media) {
      if (up("omni")) return { id: "omni" };
      return { error: "Pictures and audio need the Eyes and ears part. Turn it on in Settings → Downloads." };
    }
    if (up("small")) return { id: "small" };
    if (up("omni")) return { id: "omni" };
    const waking = ["small", "omni"].some((id) => backends.states[id]?.status === "starting");
    return { error: waking ? "The model is still waking up. Try again in a few seconds." : "No model is running yet. Open Settings → Downloads to set one up." };
  },

  async respond(chat) {
    const controller = new AbortController();
    const { signal } = controller;
    running.set(chat.id, controller);
    emitRunning();
    const request = [...chat.messages].reverse().find((m) => m.role === "user");
    const reply = { id: uid(), role: "assistant", content: "", steps: [], status: "streaming", at: Date.now() };
    chat.messages.push(reply);
    emitChat(chat);

    let live = "";
    const started = Date.now();
    let tokens = 0;
    let genMs = 0;
    try {
      const route = this.route(chat);
      if (route.error) throw new Error(route.error);
      const model = MODELS[route.id];
      reply.model = route.id;
      const offer = wantsTools(chat, request);
      for (let step = 0; ; step++) {
        // Two searches are plenty for a small model; after that it should read or answer.
        const searches = reply.steps.filter((x) => x.tool === "web_search").length;
        const tools = offer ? activeTools().filter((t) => t.name !== "web_search" || searches < 2) : [];
        const final = step === settings.maxSteps;
        const wire = buildWire(chat.messages, {
          system: systemPrompt({ tools, omni: route.id === "omni", query: request.content }),
          omni: route.id === "omni",
        });
        // Out of steps: ask for an answer from what was found instead of another call.
        if (final) {
          const nudge = "Step limit reached. Answer now from the results above. Do not call a tool.";
          const tail = wire[wire.length - 1];
          if (tail.role === "user" && typeof tail.content === "string") tail.content += `\n\n${nudge}`;
          else wire.push({ role: "user", content: nudge });
        }
        live = "";
        let shown = "";
        let last = 0;
        const thinkStart = Date.now();
        let thinkEnd = 0;
        let thought = "";
        // LFM3 1.7B always reasons first; LFM3 Omni 2B is a non-reasoning model.
        const think = route.id === "small";
        for await (const part of stream({
          url: model.url(),
          model: model.id,
          messages: wire,
          temperature: model.temperature(),
          maxTokens: think ? 6144 : 1536,
          stop: STOPS,
          think,
          signal,
        })) {
          if (part.reasoning) thought += part.reasoning;
          if (part.content) {
            live += part.content;
            if (!thinkEnd && !/^\s*<think>(?![\s\S]*<\/think>)/.test(live)) thinkEnd = Date.now();
          }
          if (part.reasoning || part.content) {
            const inline = splitThink(live);
            const visible = visibleText(inline.rest);
            if (Date.now() - last > 50 && (visible !== shown || part.reasoning || inline.thought)) {
              shown = visible;
              last = Date.now();
              bus.emit("delta", { chatId: chat.id, messageId: reply.id, text: visible, thinking: joinThoughts(reply.thinking, thought + inline.thought) });
            }
          }
          if (part.timings) {
            tokens += part.timings.predicted_n ?? 0;
            genMs += part.timings.predicted_ms ?? 0;
          }
        }

        const inline = splitThink(live);
        thought += inline.thought;
        live = inline.rest;
        if (thought.trim()) {
          reply.thinking = joinThoughts(reply.thinking, thought);
          reply.thinkingMs = (reply.thinkingMs ?? 0) + ((thinkEnd || Date.now()) - thinkStart);
        }
        const { text, call } = parseToolCall(live, new Map(tools.map((t) => [t.name, t])));
        live = "";
        if (!call) {
          reply.content = text || "I couldn't come up with a reply. Try asking another way.";
          break;
        }
        if (final) {
          reply.content = `${text ? text + "\n\n" : ""}I stopped after ${settings.maxSteps} steps. Say **continue** if you want me to keep going.`;
          break;
        }
        const tool = toolMap.get(call.name);
        const s = { id: uid(), tool: call.name, args: call.args, label: tool.label(call.args), note: text, status: "pending", at: Date.now() };
        reply.steps.push(s);
        emitChat(chat);

        const repeats = reply.steps.filter((x) => x.tool === s.tool && JSON.stringify(x.args) === JSON.stringify(s.args)).length;
        if (repeats >= 3) {
          Object.assign(s, { status: "error", result: "Skipped: same action three times." });
          reply.content = "I kept trying the same thing, so I stopped. Could you tell me more about what you want?";
          break;
        }

        const verdict = await this.decide(chat, reply, s, request.content, signal);
        s.decision = verdict.decision;
        if (!verdict.approved) {
          s.status = "denied";
          this.record(chat, s, false);
          emitChat(chat);
          continue;
        }
        s.status = "running";
        emitChat(chat);
        const result = await runTool(s.tool, s.args, { signal, chatId: chat.id });
        Object.assign(s, { status: result.ok ? "done" : "error", result: result.text, ms: Date.now() - s.at });
        this.record(chat, s, result.ok);
        emitChat(chat);
      }
      reply.status = "done";
    } catch (e) {
      if (signal.aborted) {
        reply.status = "stopped";
        reply.content = reply.content || visibleText(splitThink(live).rest).trim();
      } else {
        reply.status = "error";
        reply.error = String(e?.message ?? e);
        reply.content = reply.content || visibleText(splitThink(live).rest).trim();
      }
      for (const s of reply.steps) if (OPEN.includes(s.status)) Object.assign(s, { status: "denied", result: "Stopped." });
    } finally {
      reply.stats = { ms: Date.now() - started, tokens, tps: genMs ? Math.round((tokens / genMs) * 10000) / 10 : 0 };
      running.delete(chat.id);
      emitRunning();
      emitChat(chat);
    }

    if (reply.status !== "done") return;
    bus.emit("notify", { title: chat.title, body: reply.content.replace(/[#*_`>]/g, "").slice(0, 140), chatId: chat.id, kind: "done" });
    if (backends.running("small")) {
      const firstReply = chat.messages.filter((m) => m.role === "assistant").length === 1;
      if (firstReply && !chat.named) this.autoTitle(chat, request.content || reply.content).catch(() => {});
      if (request.content) memory.learnFrom(request.content).catch(() => {});
    }
  },

  /** Decides who approves an action, following the approval mode. Shared with voice chat. */
  async decide(chat, message, step, request, signal) {
    const tool = toolMap.get(step.tool);
    const mode = settings.approvalMode;
    const ask = (reason) => this.askUser(chat, step, reason, signal);
    if (tool?.free) return { approved: true, decision: "Automatic" };
    if (hardDeny(step.tool, step.args)) return ask(`This command can change important parts of your ${DEVICE}.`);
    if (mode === "askAlways") return ask();
    if (mode === "fullAuto") return { approved: true, decision: "Full Auto" };
    if (tool.kind !== "write") return { approved: true, decision: tool.kind === "read" ? "Read-only, safe" : "Safe" };

    step.status = "checking";
    emitChat(chat);
    const history = message.steps.filter((x) => x !== step && x.status !== "denied").map((x) => ({ tool: x.tool, args: x.args, result: x.result }));
    const pDeny = await classify(step.tool, step.args, request, history);
    if (pDeny === null) return ask("Auto 200M isn't ready yet, so I need your OK.");
    step.pDeny = Math.round(pDeny * 1000) / 1000;
    if (pDeny < settings.guardianThreshold) return { approved: true, decision: "Auto 200M approved" };
    return ask(`Auto 200M wasn't sure this is safe (${Math.round(pDeny * 100)}% risky).`);
  },

  askUser(chat, step, reason, signal) {
    step.status = "approval";
    step.reason = reason;
    emitChat(chat);
    bus.emit("notify", { title: "Liquid Agent needs your OK", body: step.label, chatId: chat.id, kind: "approval" });
    return new Promise((resolve) => {
      const done = (ok) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ approved: ok, decision: ok ? "You approved" : "You said no" });
      };
      const onAbort = () => this.approve(step.id, false);
      signal?.addEventListener("abort", onAbort, { once: true });
      approvals.set(step.id, { resolve: done, chatId: chat.id });
    });
  },

  record(chat, step, ok) {
    const entry = {
      id: uid(),
      at: Date.now(),
      chatId: chat.id,
      tool: step.tool,
      label: step.label,
      decision: step.status === "denied" ? step.decision || "Denied" : step.decision,
      ok: step.status === "denied" ? null : ok,
      pDeny: step.pDeny,
    };
    activity = [entry, ...activity].slice(0, 500);
    persistActivity();
    bus.emit("activity", { entry });
  },

  clearActivity() {
    activity = [];
    persistActivity();
    bus.emit("activity.cleared");
  },

  async autoTitle(chat, text) {
    const out = await complete({
      url: settings.smallURL,
      model: MODELS.small.id,
      temperature: 0.2,
      maxTokens: 16,
      messages: [
        { role: "system", content: "You name chats. Reply with a 2 to 5 word title in plain words, nothing else." },
        { role: "user", content: `Name a chat that starts with this message:\n"""${text.slice(0, 600)}"""` },
      ],
    });
    const title = out.split("\n")[0].replace(/^(title:)?["'#*\s]+|["'.*\s]+$/gi, "").slice(0, 60);
    if (title && !/[|`<>]/.test(title) && !chat.named && this.chat(chat.id)) {
      chat.title = title;
      emitChat(chat);
    }
  },

  emitChat,
  uid,
};
