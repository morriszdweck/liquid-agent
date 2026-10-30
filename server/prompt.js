// Builds what the model actually sees. Small models are slow to read, so
// every token counts: one short system prompt, only the tools that work right
// now, only relevant memory, and history packed newest-first into a budget.

import os from "node:os";
import { DEVICE, IS_MAC, PERSONALITIES, settings } from "./core.js";
import { memory } from "./memory.js";
import { signature } from "./tools.js";
import { uploads } from "./uploads.js";

/** Telling the model it's on Linux keeps its shell commands right for this computer. */
const MACHINE = IS_MAC ? "Mac" : "Linux computer";

const HOME = os.homedir();
const tilde = (f) => (f.startsWith(HOME) ? "~" + f.slice(HOME.length) : f);
const now = () =>
  new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export const xmlCall = (name, args) =>
  `<tool_call>\n<function=${name}>\n${Object.entries(args ?? {})
    .map(([k, v]) => `<parameter=${k}>\n${typeof v === "string" ? v : JSON.stringify(v)}\n</parameter>\n`)
    .join("")}</function>\n</tool_call>`;

function persona() {
  const name = settings.userName ? ` The user's name is ${settings.userName}.` : "";
  return `${PERSONALITIES[settings.personality] ?? ""}${name}`;
}

export function systemPrompt({ tools, omni, query }) {
  const style = "Use Markdown when it helps: headings, lists, tables, fenced code blocks with a language, and $...$ or $$...$$ for math.";
  const toolLines = tools.length
    ? [
        "Answer chat, math, writing, code and knowledge questions yourself; never search for something you can write or work out. Only when the request needs the ${DEVICE}, files, the web or memory, reply with one call only:",
        xmlCall("NAME", { ARG: "VALUE" }),
        "Tools:",
        ...tools.map(signature),
        "After a result, answer as soon as you know enough; use another tool only if needed. Use remember for lasting facts about the user.",
      ]
    : ["Answer directly."];
  return [
    `You are Liquid Agent, a private assistant running locally on the user's ${MACHINE}. ${persona()}`,
    style,
    ...toolLines,
    omni && "You can see and hear attachments.",
    `Now: ${now()}. Workspace: ${tilde(settings.workspace)}`,
    memory.promptBlock(query),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Instructions for Omni's realtime voice session. Spoken replies must stay short and plain. */
export function voiceInstructions(history = []) {
  const recent = history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "You"}: ${String(m.content).replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");
  return [
    `You are Liquid Agent, a private voice assistant running locally on the user's ${MACHINE}. ${persona()}`,
    "You are speaking out loud. Answer in one or two short sentences with plain, natural words. Never use markdown, lists, symbols, emoji or code.",
    `When the user asks you to do something on the ${DEVICE}, with files, reminders or memory, call a tool, then say the result in a few words. For news, weather, prices or facts you aren't sure of, use web_search first.`,
    "When the user's camera is on, their message ends with a note like (On camera right now: ...). That is what you can see through the camera: use it when it helps, and don't read the note out.",
    `Now: ${now()}.`,
    memory.promptBlock(recent),
    recent && `Earlier in this chat:\n${recent}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- History packing ----

const IMAGE_TOKENS = 1000;
const estimate = (content) =>
  typeof content === "string"
    ? Math.ceil(content.length / 4)
    : content.reduce(
        (n, part) =>
          n +
          (part.type === "text"
            ? Math.ceil(part.text.length / 4)
            : part.type === "image_url"
              ? IMAGE_TOKENS
              : Math.ceil((part.input_audio.data.length * 0.75) / 32000) * 25 + 20),
        0,
      );

function userWire(message, { omni, latest, media }) {
  const parts = [];
  let text = message.content ?? "";
  for (const a of message.attachments ?? []) {
    if (a.kind === "text") {
      const body = uploads.text(a.id);
      const cap = latest ? 8000 : 600;
      text += `\n\n[File: ${a.name}]\n${body.length > cap ? body.slice(0, cap) + "\n…(cut)" : body}`;
    } else if ((a.kind === "image" || a.kind === "audio") && omni && !media.has(a.kind)) {
      const data = uploads.base64(a.id);
      if (!data) {
        text += `\n[${a.kind}: ${a.name}, no longer available]`;
        continue;
      }
      media.add(a.kind);
      parts.push(
        a.kind === "image"
          ? { type: "image_url", image_url: { url: `data:${a.mime};base64,${data}` } }
          : { type: "input_audio", input_audio: { data, format: "wav" } },
      );
    } else {
      text += `\n[${a.kind === "other" ? "file" : a.kind}: ${a.name}]`;
    }
  }
  if (!parts.length) return text;
  if (text.trim()) parts.push({ type: "text", text: text.trim() });
  return parts;
}

function assistantWire(message, { latest }) {
  const out = [];
  for (const step of message.steps ?? []) {
    if (!["done", "error", "denied"].includes(step.status)) continue;
    out.push({ role: "assistant", content: `${step.note ? step.note + "\n" : ""}${xmlCall(step.tool, step.args)}` });
    const result = step.status === "denied" ? "The user said no to this action. Don't retry it; tell the user." : (step.result ?? "");
    out.push({ role: "user", content: `[result]\n${latest || result.length <= 240 ? result : result.slice(0, 240) + "…"}` });
  }
  if (message.content?.trim()) out.push({ role: "assistant", content: message.content });
  return out;
}

/** Packs chat history into the token budget, newest first. The newest user turn is always kept. */
export function buildWire(messages, { system, omni, budget = settings.contextBudget }) {
  const media = new Set(); // only the newest image and the newest audio are sent
  const chunks = [];
  let used = estimate(system);
  let sawUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Before the newest user message is reached we are inside the current turn: keep it whole.
    const latest = !sawUser;
    const wire =
      m.role === "user" ? [{ role: "user", content: userWire(m, { omni, latest, media }) }] : assistantWire(m, { latest });
    const cost = wire.reduce((n, w) => n + estimate(w.content), 0);
    if (sawUser && used + cost > budget) break;
    used += cost;
    chunks.unshift(...wire);
    if (m.role === "user") sawUser = true;
  }
  while (chunks.length && chunks[0].role !== "user") chunks.shift();
  return [{ role: "system", content: system }, ...mergeSameRole(chunks)];
}

function mergeSameRole(messages) {
  const out = [];
  const asParts = (c) => (typeof c === "string" ? (c ? [{ type: "text", text: c }] : []) : c);
  for (const m of messages) {
    const last = out[out.length - 1];
    if (!last || last.role !== m.role) {
      out.push({ ...m });
    } else if (typeof last.content === "string" && typeof m.content === "string") {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      last.content = [...asParts(last.content), ...asParts(m.content)];
    }
  }
  return out;
}
