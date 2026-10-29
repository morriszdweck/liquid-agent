// One-click tasks that can also run on a schedule. Each run is a new chat.

import crypto from "node:crypto";
import { IS_MAC, bus, load, save } from "./core.js";
import { agent } from "./agent.js";

const STARTERS = [
  {
    name: "Morning briefing",
    icon: "sun",
    color: "#f5a524",
    prompt: "Give me a short morning briefing: today's date, the weather where I live if you know it, and three top news headlines. Search the web for the news.",
    schedule: { enabled: false, time: "08:00", days: [1, 2, 3, 4, 5] },
  },
  {
    name: "Tidy Downloads",
    icon: "folder",
    color: "#339cff",
    prompt: "Look at my ~/Downloads folder and suggest how to tidy it: group the files by type and point out old installers and duplicates. Don't move or delete anything yet.",
    schedule: { enabled: false, time: "18:00", days: [5] },
  },
  {
    name: "Today's news",
    icon: "newspaper",
    color: "#a855f7",
    prompt: "Search the web for today's most important news and summarize the five biggest stories in one or two sentences each.",
    schedule: { enabled: false, time: "12:00", days: [0, 1, 2, 3, 4, 5, 6] },
  },
  {
    name: IS_MAC ? "Check my Mac" : "Check my computer",
    icon: "gauge",
    color: "#22c55e",
    prompt: IS_MAC
      ? "Check my Mac's health: free disk space, memory pressure, battery condition and uptime. Use shell commands, then explain the results simply."
      : "Check my computer's health: free disk space, memory use, battery condition if it has one, uptime and failed system services. Use shell commands, then explain the results simply.",
    schedule: { enabled: false, time: "09:00", days: [1] },
  },
];

let routines = load("routines.v2.json", null);
if (!routines) {
  routines = STARTERS.map((r) => ({ id: crypto.randomUUID(), ...r, lastRun: 0 }));
  save("routines.v2.json", routines);
}

const persist = () => {
  save("routines.v2.json", routines);
  bus.emit("routines", { routines });
};

function clean(input, base = {}) {
  const r = { ...base };
  if (typeof input.name === "string" && input.name.trim()) r.name = input.name.trim().slice(0, 60);
  if (typeof input.prompt === "string" && input.prompt.trim()) r.prompt = input.prompt.trim().slice(0, 2000);
  if (typeof input.icon === "string") r.icon = input.icon.slice(0, 30);
  if (typeof input.color === "string" && /^#[0-9a-f]{6}$/i.test(input.color)) r.color = input.color;
  if (input.schedule && typeof input.schedule === "object") {
    const s = input.schedule;
    r.schedule = {
      enabled: Boolean(s.enabled),
      time: /^\d{2}:\d{2}$/.test(s.time) ? s.time : (base.schedule?.time ?? "09:00"),
      days: Array.isArray(s.days) ? [...new Set(s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : (base.schedule?.days ?? []),
    };
  }
  return r;
}

export const routineStore = {
  get list() {
    return routines;
  },

  create(input) {
    const r = clean(input, {
      id: crypto.randomUUID(),
      name: "New routine",
      icon: "sparkles",
      color: "#339cff",
      prompt: "",
      schedule: { enabled: false, time: "09:00", days: [1, 2, 3, 4, 5] },
      lastRun: 0,
    });
    if (!r.prompt) throw new Error("Write what the routine should do.");
    routines.push(r);
    persist();
    return r;
  },

  update(id, input) {
    const i = routines.findIndex((r) => r.id === id);
    if (i < 0) return null;
    routines[i] = clean(input, routines[i]);
    persist();
    return routines[i];
  },

  remove(id) {
    routines = routines.filter((r) => r.id !== id);
    persist();
  },

  run(id) {
    const r = routines.find((x) => x.id === id);
    if (!r) return null;
    const chat = agent.create({ title: r.name, source: "routine" });
    chat.named = true;
    agent.send(chat.id, { text: r.prompt });
    r.lastRun = Date.now();
    r.lastChatId = chat.id;
    persist();
    return chat;
  },
};

// Checks the schedule twice a minute; each routine runs at most once per scheduled minute.
setInterval(() => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  for (const r of routines) {
    const s = r.schedule;
    if (!s?.enabled || s.time !== hhmm || !s.days.includes(now.getDay())) continue;
    if (Date.now() - (r.lastRun ?? 0) < 120_000) continue;
    try {
      routineStore.run(r.id);
      bus.emit("notify", { title: `Running “${r.name}”`, body: "Your scheduled routine started.", chatId: r.lastChatId, kind: "routine" });
    } catch {}
  }
}, 30_000).unref();
