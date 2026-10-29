// App state, kept in sync with the server over one WebSocket.

import { create } from "zustand";
import { socketURL } from "./api";
import type { ActivityEntry, Chat, Idea, Part, Reminder, Routine, Settings, Snapshot, Step } from "./types";

export type Toast = { id: number; text: string; tone?: "error" | "info" };
export type Route =
  | { page: "chat"; chatId?: string }
  | { page: "voice"; chatId?: string }
  | { page: "foryou" }
  | { page: "routines" }
  | { page: "memory" }
  | { page: "activity" };

type State = {
  connected: boolean;
  loaded: boolean;
  chats: Chat[];
  running: string[];
  live: Record<string, string>;
  /** What each answer is thinking right now, while it streams. */
  thoughts: Record<string, string>;
  settings: Settings | null;
  parts: Part[];
  busy: boolean;
  guardianWanted: boolean;
  machine: { memoryGB: number };
  memory: string[];
  ideas: { at: number; items: Idea[] };
  routines: Routine[];
  activity: ActivityEntry[];
  reminders: Reminder[];
  dataDir: string;
  route: Route;
  settingsOpen: string | null;
  sidebarOpen: boolean;
  toasts: Toast[];
  speaking: string | null;
};

export const useStore = create<State>(() => ({
  connected: false,
  loaded: false,
  chats: [],
  running: [],
  live: {},
  thoughts: {},
  settings: null,
  parts: [],
  busy: false,
  guardianWanted: false,
  machine: { memoryGB: 0 },
  memory: [],
  ideas: { at: 0, items: [] },
  routines: [],
  activity: [],
  reminders: [],
  dataDir: "",
  route: parseRoute(),
  settingsOpen: null,
  sidebarOpen: false,
  toasts: [],
  speaking: null,
}));

const set = useStore.setState;
const get = useStore.getState;

// ---- Routing (hash based, so the server only serves one page) ----

function parseRoute(): Route {
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  switch (page) {
    case "voice":
      return { page: "voice", chatId: id };
    case "foryou":
    case "routines":
    case "memory":
    case "activity":
      return { page };
    case "chat":
      return { page: "chat", chatId: id };
    default:
      return { page: "chat" };
  }
}

export function go(hash: string) {
  if (location.hash !== hash) location.hash = hash;
  else set({ route: parseRoute() });
  set({ sidebarOpen: false });
}
window.addEventListener("hashchange", () => set({ route: parseRoute() }));

// ---- Toasts ----

let toastId = 0;
export function toast(text: string, tone: Toast["tone"] = "info") {
  const id = ++toastId;
  set({ toasts: [...get().toasts, { id, text, tone }] });
  setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), tone === "error" ? 6000 : 3500);
}

export const errorToast = (e: unknown) => toast(e instanceof Error ? e.message : String(e), "error");

// ---- Desktop notifications when the tab is in the background ----

function notify(title: string, body: string, chatId?: string) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(title, { body, icon: "/icon.svg", tag: chatId });
  n.onclick = () => {
    window.focus();
    if (chatId) go(`#/chat/${chatId}`);
    n.close();
  };
}

// ---- Socket ----

let socket: WebSocket | null = null;
let retry = 0;

function upsertChat(chat: Chat) {
  const before = get().chats.find((c) => c.id === chat.id);
  const chats = get().chats.filter((c) => c.id !== chat.id);
  const live = { ...get().live };
  const thoughts = { ...get().thoughts };
  for (const m of chat.messages) {
    // A new step means the streamed text so far became that step's note.
    const old = before?.messages.find((x) => x.id === m.id);
    if (m.status !== "streaming" || (old && (old.steps?.length ?? 0) !== (m.steps?.length ?? 0))) delete live[m.id];
    if (m.status !== "streaming") delete thoughts[m.id];
  }
  set({ chats: [chat, ...chats].sort((a, b) => b.updatedAt - a.updatedAt), live, thoughts });
}

type Event =
  | ({ type: "hello" } & Snapshot)
  | { type: "chat"; chat: Chat }
  | { type: "chat.deleted"; id: string }
  | { type: "delta"; chatId: string; messageId: string; text: string; thinking?: string }
  | { type: "running"; running: string[] }
  | { type: "parts"; parts: Part[]; busy: boolean; guardianWanted: boolean }
  | { type: "settings"; settings: Settings }
  | { type: "memory"; facts: string[] }
  | { type: "ideas"; ideas: { at: number; items: Idea[] } }
  | { type: "routines"; routines: Routine[] }
  | { type: "reminders"; reminders: Reminder[] }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "activity.cleared" }
  | { type: "notify"; title: string; body: string; chatId?: string; kind?: string };

function onEvent(e: Event) {
  switch (e.type) {
    case "hello": {
      const { type: _, ...snapshot } = e;
      set({ ...snapshot, chats: [...snapshot.chats].sort((a, b) => b.updatedAt - a.updatedAt), loaded: true, live: {} });
      break;
    }
    case "chat":
      upsertChat(e.chat);
      break;
    case "chat.deleted":
      set({ chats: get().chats.filter((c) => c.id !== e.id) });
      break;
    case "delta":
      set({ live: { ...get().live, [e.messageId]: e.text }, ...(e.thinking ? { thoughts: { ...get().thoughts, [e.messageId]: e.thinking } } : {}) });
      break;
    case "running":
      set({ running: e.running });
      break;
    case "parts":
      set({ parts: e.parts, busy: e.busy, guardianWanted: e.guardianWanted });
      break;
    case "settings":
      set({ settings: e.settings });
      break;
    case "memory":
      set({ memory: e.facts });
      break;
    case "ideas":
      set({ ideas: e.ideas });
      break;
    case "routines":
      set({ routines: e.routines });
      break;
    case "reminders":
      set({ reminders: e.reminders });
      break;
    case "activity":
      set({ activity: [e.entry, ...get().activity].slice(0, 200) });
      break;
    case "activity.cleared":
      set({ activity: [] });
      break;
    case "notify":
      if (e.kind === "done" || e.kind === "approval" || e.kind === "routine") notify(e.title, e.body, e.chatId);
      else {
        toast(`${e.title}: ${e.body}`);
        notify(e.title, e.body, e.chatId);
      }
      break;
  }
}

export function connect() {
  socket = new WebSocket(socketURL("/ws"));
  socket.onopen = () => {
    retry = 0;
    set({ connected: true });
  };
  socket.onmessage = (m) => onEvent(JSON.parse(m.data));
  socket.onclose = () => {
    set({ connected: false });
    socket = null;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 300 * 2 ** retry);
  };
}

// ---- Selectors ----

export const pendingApprovals = (chats: Chat[], chatId?: string) => {
  const out: { chat: Chat; step: Step }[] = [];
  for (const chat of chats) {
    if (chatId && chat.id !== chatId) continue;
    const last = chat.messages[chat.messages.length - 1];
    for (const step of last?.steps ?? []) if (step.status === "approval") out.push({ chat, step });
  }
  return out;
};

export const modelsReady = (parts: Part[]) => parts.some((p) => (p.id === "small" || p.id === "omni") && p.status === "running");
export const part = (parts: Part[], id: Part["id"]) => parts.find((p) => p.id === id);
