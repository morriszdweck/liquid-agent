// Everything the agent can do. Each tool lists its parameters once; that list
// becomes the one-line signature in the text prompt and the JSON schema for
// Omni's realtime voice session.
//
// kind: "read"  only looks at things, so Approve for Me runs it without asking
//       "safe"  changes nothing outside the app (memory, reminders)
//       "write" changes something, so Auto 200M or the user must approve it

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIRS, SHELL, bus, isLocal, load, save, settings, shell } from "./core.js";
import { backends } from "./backends.js";
import { memory } from "./memory.js";
import { look, transcribe } from "./omni.js";
import { notify, openApp, openPath, pictureForModel, readClipboard, screenshot, toWav, writeClipboard } from "./platform.js";

const HOME = os.homedir();
const UA =
  process.platform === "darwin"
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
    : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const p = (name, desc, extra = {}) => ({ name, desc, type: "string", ...extra });
const short = (s, n = 60) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const home = (f) => (f === "~" || f.startsWith("~/") ? path.join(HOME, f.slice(1)) : f);

/** Resolves ~ and paths relative to the workspace folder. */
export function expand(file) {
  const base = home(settings.workspace || HOME);
  const f = String(file ?? "").trim();
  return f ? path.resolve(base, home(f)) : base;
}

const tilde = (f) => (f.startsWith(HOME) ? "~" + f.slice(HOME.length) : f);

function htmlText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article|header|footer)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function decode(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Only public web addresses: a web page must not steer the agent into this computer's own services. */
function publicURL(raw) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("That isn't a web address.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !/^https?:$/.test(url.protocol) ||
    isLocal(url.href) ||
    /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(host) ||
    host.endsWith(".local") ||
    !host.includes(".")
  ) {
    throw new Error("Only public websites can be opened.");
  }
  return url.href;
}

async function bridge(action, body) {
  const res = await fetch(`${settings.browserURL}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const out = await res.json();
  if (out.error) return `error: ${out.error}`;
  return out.text ?? "";
}

async function search(query) {
  // DuckDuckGo sometimes drops the first connection, so try a few times with a short timeout.
  let html;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ q: query }),
        signal: AbortSignal.timeout(7_000),
      });
      html = await res.text();
      break;
    } catch (e) {
      if (attempt === 3) throw new Error("Couldn't reach the search engine. Check the internet connection.");
    }
  }
  const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const results = links.slice(0, 6).map((m, i) => {
    let href = decode(m[1]);
    const real = href.match(/uddg=([^&]+)/);
    if (real) href = decodeURIComponent(real[1]);
    const title = htmlText(m[2]);
    const snippet = snippets[i] ? htmlText(snippets[i][1]) : "";
    return `${i + 1}. ${title}\n${href}\n${snippet}`;
  });
  return results.length ? results.join("\n\n") : "No results.";
}

// ---- Reminders ----

let reminders = load("reminders.json", []);

function fireReminders() {
  const now = Date.now();
  const due = reminders.filter((r) => r.at <= now);
  if (!due.length) return;
  reminders = reminders.filter((r) => r.at > now);
  save("reminders.json", reminders);
  bus.emit("reminders", { reminders });
  for (const r of due) {
    bus.emit("notify", { title: "Reminder", body: r.text });
    notify(r.text).catch(() => {});
  }
}
setInterval(fireReminders, 15_000).unref();

export const reminderList = () => reminders;
export function cancelReminder(id) {
  reminders = reminders.filter((r) => r.id !== id);
  save("reminders.json", reminders);
  bus.emit("reminders", { reminders });
}

// ---- Tools ----

const omniRunning = () => backends.running("omni");
const browserRunning = () => backends.running("browser");

export const TOOLS = [
  {
    name: "shell",
    desc: `run a ${path.basename(SHELL)} command`,
    params: [p("command", "the command")],
    kind: "write",
    label: (a) => `Ran \`${short(a.command, 80)}\``,
    run: (a, ctx) => shell(String(a.command ?? ""), { cwd: expand(settings.workspace), signal: ctx.signal }),
  },
  {
    name: "read_file",
    desc: "read a text file",
    params: [p("path", "file path")],
    kind: "read",
    limit: 3,
    label: (a) => `Read ${tilde(expand(a.path))}`,
    run(a) {
      const file = expand(a.path);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return `${tilde(file)} is a folder. Use list_dir.`;
      if (stat.size > 2_000_000) return `${tilde(file)} is too big to read (${Math.round(stat.size / 1e6)} MB).`;
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 4000).includes(0)) return `${tilde(file)} is not a text file.${/\.(png|jpe?g|gif|webp|heic)$/i.test(file) ? " Use look_at_image." : ""}`;
      return buf.toString("utf8");
    },
  },
  {
    name: "write_file",
    desc: "create or overwrite a text file",
    params: [p("path", "file path"), p("content", "full file content")],
    kind: "write",
    label: (a) => `Wrote ${tilde(expand(a.path))}`,
    run(a) {
      const file = expand(a.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(a.content ?? ""));
      return `Saved ${tilde(file)} (${Buffer.byteLength(String(a.content ?? ""))} bytes).`;
    },
  },
  {
    name: "list_dir",
    desc: "list a folder",
    params: [p("path", "folder path", { required: false })],
    kind: "read",
    label: (a) => `Listed ${tilde(expand(a.path))}`,
    run(a) {
      const dir = expand(a.path);
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
      const lines = entries.slice(0, 120).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      if (entries.length > 120) lines.push(`…and ${entries.length - 120} more`);
      return `${tilde(dir)} (${entries.length} items)\n${lines.join("\n") || "(empty)"}`;
    },
  },
  {
    name: "open",
    desc: "open an app, file or website",
    params: [p("target", "app name, path or URL")],
    kind: "write",
    label: (a) => `Opened ${short(a.target)}`,
    async run(a) {
      const target = String(a.target ?? "").trim();
      if (/^https?:\/\//i.test(target) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(target)) {
        await openPath(publicURL(target));
      } else if (fs.existsSync(expand(target))) {
        await openPath(expand(target));
      } else {
        await openApp(target);
      }
      return `Opened ${target}.`;
    },
  },
  {
    name: "web_search",
    desc: "search the web",
    params: [p("query", "search words")],
    kind: "read",
    label: (a) => `Searched the web for “${short(a.query)}”`,
    run: (a) => search(String(a.query ?? "")),
  },
  {
    name: "fetch_url",
    desc: "read a web page as text",
    params: [p("url", "page address")],
    kind: "read",
    limit: 3,
    label: (a) => `Read ${short(String(a.url).replace(/^https?:\/\//, ""))}`,
    async run(a) {
      const res = await fetch(publicURL(String(a.url ?? "")), {
        headers: { "User-Agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      if (!type.includes("html")) return body;
      const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      // Skip menus and footers when the page marks its main content.
      const main = body.match(/<main[\s>][\s\S]*?<\/main>/i)?.[0] ?? body.match(/<article[\s>][\s\S]*?<\/article>/i)?.[0] ?? body;
      return `${title ? `Title: ${htmlText(title)}\n\n` : ""}${htmlText(main)}`;
    },
  },
  {
    name: "browser_goto",
    desc: "open a page in the agent's browser",
    params: [p("url", "page address")],
    kind: "write",
    limit: 3,
    available: browserRunning,
    label: (a) => `Went to ${short(String(a.url).replace(/^https?:\/\//, ""))}`,
    run: (a) => bridge("goto", { url: publicURL(String(a.url ?? "")) }),
  },
  {
    name: "browser_read",
    desc: "read the current browser page",
    params: [],
    kind: "read",
    limit: 3,
    available: browserRunning,
    label: () => "Read the page",
    run: () => bridge("read", {}),
  },
  {
    name: "browser_click",
    desc: "click a button or link by its text",
    params: [p("target", "visible text or CSS selector")],
    kind: "write",
    limit: 3,
    available: browserRunning,
    label: (a) => `Clicked “${short(a.target)}”`,
    run: (a) => bridge("click", { target: String(a.target ?? "") }),
  },
  {
    name: "browser_type",
    desc: "type into a field",
    params: [p("target", "field label, placeholder or selector"), p("text", "what to type")],
    kind: "write",
    available: browserRunning,
    label: (a) => `Typed into “${short(a.target)}”`,
    run: (a) => bridge("type", { target: String(a.target ?? ""), text: String(a.text ?? "") }),
  },
  {
    name: "look_at_screen",
    desc: "see the user's screen",
    params: [p("question", "what to look for", { required: false })],
    kind: "read",
    available: omniRunning,
    label: () => "Looked at your screen",
    async run(a, ctx) {
      const file = path.join(DIRS.uploads, `screen-${crypto.randomUUID()}.png`);
      const tmp = file.replace(/\.png$/, ".jpg");
      try {
        await screenshot(file);
        const picture = await pictureForModel(file, tmp);
        return await look(picture.data, picture.mime, String(a.question || "Describe what is on this screen."), ctx);
      } finally {
        fs.rmSync(file, { force: true });
        fs.rmSync(tmp, { force: true });
      }
    },
  },
  {
    name: "look_at_image",
    desc: "see a picture file",
    params: [p("path", "image path"), p("question", "what to look for", { required: false })],
    kind: "read",
    available: omniRunning,
    label: (a) => `Looked at ${path.basename(String(a.path ?? ""))}`,
    async run(a, ctx) {
      const file = expand(a.path);
      const tmp = path.join(DIRS.uploads, `look-${crypto.randomUUID()}.jpg`);
      try {
        const picture = await pictureForModel(file, tmp);
        return await look(picture.data, picture.mime, String(a.question || "Describe this picture."), ctx);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  },
  {
    name: "transcribe_audio",
    desc: "turn an audio file into text",
    params: [p("path", "audio path")],
    kind: "read",
    limit: 3,
    available: omniRunning,
    label: (a) => `Listened to ${path.basename(String(a.path ?? ""))}`,
    async run(a, ctx) {
      const tmp = path.join(DIRS.uploads, `hear-${crypto.randomUUID()}.wav`);
      try {
        await toWav(expand(a.path), tmp);
        return await transcribe(fs.readFileSync(tmp), ctx);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  },
  {
    name: "remember",
    desc: "save a lasting fact about the user",
    params: [p("fact", "short fact")],
    kind: "safe",
    label: (a) => `Remembered “${short(a.fact)}”`,
    run: (a) => (memory.add(a.fact) ? "Saved." : "Already known."),
  },
  {
    name: "recall",
    desc: "search what you know about the user",
    params: [p("query", "topic")],
    kind: "safe",
    free: true,
    label: (a) => `Recalled “${short(a.query)}”`,
    run: (a) => memory.search(String(a.query ?? ""), 8).join("\n") || "Nothing saved about that.",
  },
  {
    name: "clipboard",
    desc: "read the clipboard",
    params: [],
    kind: "read",
    label: () => "Read the clipboard",
    run: () => readClipboard(),
  },
  {
    name: "set_clipboard",
    desc: "copy text to the clipboard",
    params: [p("text", "text to copy")],
    kind: "safe",
    label: () => "Copied to the clipboard",
    run: (a) => writeClipboard(String(a.text ?? "")).then(() => "Copied."),
  },
  {
    name: "reminder",
    desc: "remind the user later",
    params: [p("text", "what to remind"), p("minutes", "minutes from now", { type: "number" })],
    kind: "safe",
    label: (a) => `Set a reminder in ${a.minutes} min`,
    run(a) {
      const minutes = Math.max(0.5, Number(a.minutes) || 10);
      const at = Date.now() + minutes * 60_000;
      reminders.push({ id: crypto.randomUUID(), text: String(a.text ?? "Reminder"), at });
      save("reminders.json", reminders);
      bus.emit("reminders", { reminders });
      return `I'll remind you at ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    },
  },
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools the model can use right now. */
export const activeTools = () => TOOLS.filter((t) => !t.available || t.available());

/** One compact line per tool, for the text prompt. */
export const signature = (t) => `- ${t.name}(${t.params.map((x) => x.name).join(", ")}) ${t.desc}`;

/** OpenAI-style function schema, for the realtime voice session. */
export const schema = (t) => ({
  type: "function",
  name: t.name,
  description: t.desc,
  parameters: {
    type: "object",
    properties: Object.fromEntries(t.params.map((x) => [x.name, { type: x.type, description: x.desc }])),
    required: t.params.filter((x) => x.required !== false).map((x) => x.name),
  },
});

/** Runs a tool and returns text for the model, cut to the output budget. */
export async function runTool(name, args, ctx) {
  const tool = toolMap.get(name);
  if (!tool) return { ok: false, text: `Unknown tool ${name}.` };
  try {
    const out = String((await tool.run(args, ctx)) ?? "").trim() || "(no output)";
    const limit = settings.toolOutputLimit * (tool.limit ?? 1);
    return { ok: !/^(exit \d+|error:)/.test(out), text: out.length > limit ? `${out.slice(0, limit)}\n…(${out.length - limit} more characters cut)` : out };
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    const cause = e?.cause?.code ?? e?.cause?.message;
    const message = e?.code === "ENOENT" ? "Not found." : `${e?.message ?? e}${cause ? ` (${cause})` : ""}`;
    return { ok: false, text: `error: ${message.slice(0, 500)}` };
  }
}
