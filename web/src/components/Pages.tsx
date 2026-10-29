// The other sidebar pages: For You, Routines, Memory and Activity.

import { useState } from "react";
import {
  Bell,
  Brain,
  Calendar,
  Check,
  Coffee,
  Folder,
  Gauge,
  Heart,
  History,
  Mail,
  Newspaper,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { errorToast, go, part, toast, useStore } from "../store";
import type { Chat, Routine } from "../types";
import { clock, cx, timeAgo } from "../util";
import { STARTERS } from "./ChatView";
import { Page } from "./Shell";
import { ToolIcon } from "./Steps";
import { Empty, Modal, Spinner, Toggle } from "./ui";

const startChat = (text: string) => api<Chat>("POST", "/api/chats", { text }).then((c) => go(`#/chat/${c.id}`), errorToast);

// ---- For You ----

export function ForYou() {
  const { ideas, memory, reminders, parts } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const canRefresh = part(parts, "small")?.status === "running";

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api("POST", "/api/ideas/refresh");
    } catch (e) {
      errorToast(e);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Page
      title="For You"
      right={
        <button className="btn" onClick={refresh} disabled={refreshing || !canRefresh}>
          {refreshing ? <Spinner size={13} /> : <RefreshCw size={14} />} New ideas
        </button>
      }
    >
      <p className="page-lead">Ideas picked from what Liquid Agent knows about you. Everything stays on this Mac.</p>
      <div className="idea-grid big">
        {(ideas.items.length ? ideas.items : STARTERS).map((idea) => (
          <button key={idea.title} className="idea-card" onClick={() => startChat(idea.prompt)}>
            <Sparkles size={16} className="idea-icon" />
            <span className="idea-title">{idea.title}</span>
            <span className="idea-prompt">{idea.prompt}</span>
          </button>
        ))}
      </div>
      <div className="muted small">
        {ideas.items.length
          ? `Updated ${timeAgo(ideas.at)}`
          : "Starter ideas. Tell me a little about yourself and these will fit you better."}
      </div>

      <section className="section">
        <div className="section-head">
          <h2>What I know about you</h2>
          <button className="link" onClick={() => go("#/memory")}>
            Manage
          </button>
        </div>
        {memory.length ? (
          <div className="fact-cloud">
            {memory.slice(0, 12).map((f) => (
              <span key={f} className="fact-chip">
                {f}
              </span>
            ))}
          </div>
        ) : (
          <div className="muted">Nothing yet. Say “remember that I…” in any chat.</div>
        )}
      </section>

      {reminders.length > 0 && <Reminders />}
    </Page>
  );
}

function Reminders() {
  const reminders = useStore((s) => s.reminders);
  return (
    <section className="section">
      <div className="section-head">
        <h2>Reminders</h2>
      </div>
      <div className="list">
        {reminders.map((r) => (
          <div key={r.id} className="list-row">
            <Bell size={15} className="muted" />
            <span className="list-main">{r.text}</span>
            <span className="muted small">{new Date(r.at).toDateString() === new Date().toDateString() ? clock(r.at) : new Date(r.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            <button className="icon-btn" aria-label="Cancel reminder" title="Cancel reminder" onClick={() => api("DELETE", `/api/reminders/${r.id}`).catch(errorToast)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Routines ----

const ROUTINE_ICONS: Record<string, typeof Sun> = { sun: Sun, folder: Folder, newspaper: Newspaper, gauge: Gauge, sparkles: Sparkles, mail: Mail, calendar: Calendar, coffee: Coffee, heart: Heart, bell: Bell };
const COLORS = ["#339cff", "#f5a524", "#a855f7", "#22c55e", "#ef4444", "#ec4899", "#14b8a6", "#64748b"];
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

function scheduleText(r: Routine) {
  const s = r.schedule;
  if (!s.enabled) return "Run by hand";
  const [h, m] = s.time.split(":").map(Number);
  const time = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = s.days.length === 7 ? "Every day" : s.days.join() === "1,2,3,4,5" ? "Weekdays" : s.days.join() === "0,6" ? "Weekends" : s.days.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ");
  return `${days} at ${time}`;
}

export function Routines() {
  const routines = useStore((s) => s.routines);
  const reminders = useStore((s) => s.reminders);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const run = async (r: Routine) => {
    setStarting(r.id);
    try {
      const chat = await api<Chat>("POST", `/api/routines/${r.id}/run`);
      go(`#/chat/${chat.id}`);
    } catch (e) {
      errorToast(e);
    } finally {
      setStarting(null);
    }
  };

  return (
    <Page
      title="Routines"
      right={
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={15} /> New routine
        </button>
      }
    >
      <p className="page-lead">Tasks you can run with one click, or on a schedule while this page's server is running.</p>
      <div className="routine-grid">
        {routines.map((r) => {
          const Icon = ROUTINE_ICONS[r.icon] ?? Sparkles;
          return (
            <div key={r.id} className="routine-card">
              <div className="routine-top">
                <span className="routine-icon" style={{ background: r.color }}>
                  <Icon size={18} />
                </span>
                <Toggle
                  label="Run on schedule"
                  checked={r.schedule.enabled}
                  onChange={(enabled) => api("PATCH", `/api/routines/${r.id}`, { schedule: { ...r.schedule, enabled } }).catch(errorToast)}
                />
              </div>
              <div className="routine-name">{r.name}</div>
              <div className="routine-prompt">{r.prompt}</div>
              <div className="routine-foot">
                <span className={cx("pill", r.schedule.enabled ? "pill-accent" : "pill-muted")}>
                  <Repeat size={11} /> {scheduleText(r)}
                </span>
                <div className="routine-actions">
                  <button className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setEditing(r)}>
                    <Pencil size={14} />
                  </button>
                  <button className="btn small primary" onClick={() => run(r)} disabled={starting === r.id}>
                    {starting === r.id ? <Spinner size={12} /> : <Play size={12} fill="currentColor" />} Run
                  </button>
                </div>
              </div>
              {r.lastRun > 0 && (
                <button className="routine-last link" onClick={() => r.lastChatId && go(`#/chat/${r.lastChatId}`)}>
                  Last run {timeAgo(r.lastRun)}
                </button>
              )}
            </div>
          );
        })}
        <button className="routine-card add" onClick={() => setEditing("new")}>
          <Plus size={20} />
          <span>New routine</span>
        </button>
      </div>
      {reminders.length > 0 && <Reminders />}
      {editing && <RoutineEditor routine={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function RoutineEditor({ routine, onClose }: { routine?: Routine; onClose: () => void }) {
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [icon, setIcon] = useState(routine?.icon ?? "sparkles");
  const [color, setColor] = useState(routine?.color ?? COLORS[0]);
  const [schedule, setSchedule] = useState(routine?.schedule ?? { enabled: false, time: "09:00", days: [1, 2, 3, 4, 5] });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim() || !prompt.trim()) return toast("Give the routine a name and say what it should do.", "error");
    setSaving(true);
    try {
      const body = { name, prompt, icon, color, schedule };
      if (routine) await api("PATCH", `/api/routines/${routine.id}`, body);
      else await api("POST", "/api/routines", body);
      onClose();
    } catch (e) {
      errorToast(e);
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!routine || !confirm(`Delete “${routine.name}”?`)) return;
    await api("DELETE", `/api/routines/${routine.id}`).catch(errorToast);
    onClose();
  };

  return (
    <Modal
      title={routine ? "Edit routine" : "New routine"}
      onClose={onClose}
      footer={
        <>
          {routine && (
            <button className="btn danger-text" onClick={remove}>
              <Trash2 size={14} /> Delete
            </button>
          )}
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving && <Spinner size={13} />} Save
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Evening wind-down" autoFocus />
      </label>
      <label className="field">
        <span>What should it do?</span>
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Tell me what's on my calendar tomorrow and suggest a good bedtime." />
      </label>
      <div className="field">
        <span>Look</span>
        <div className="picker-row">
          {Object.entries(ROUTINE_ICONS).map(([key, Icon]) => (
            <button key={key} className={cx("swatch", icon === key && "selected")} onClick={() => setIcon(key)} aria-label={key} style={icon === key ? { background: color, color: "#fff" } : undefined}>
              <Icon size={15} />
            </button>
          ))}
        </div>
        <div className="picker-row">
          {COLORS.map((c) => (
            <button key={c} className={cx("color-dot", color === c && "selected")} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
          ))}
        </div>
      </div>
      <div className="field">
        <div className="field-row">
          <span>Run on a schedule</span>
          <Toggle checked={schedule.enabled} onChange={(enabled) => setSchedule({ ...schedule, enabled })} />
        </div>
        {schedule.enabled && (
          <div className="schedule">
            <input type="time" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
            <div className="days">
              {DAYS.map((d, i) => (
                <button
                  key={i}
                  className={cx("day", schedule.days.includes(i) && "selected")}
                  onClick={() => setSchedule({ ...schedule, days: schedule.days.includes(i) ? schedule.days.filter((x) => x !== i) : [...schedule.days, i].sort() })}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- Memory ----

export function Memory() {
  const memory = useStore((s) => s.memory);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [value, setValue] = useState("");

  const add = async () => {
    if (!adding.trim()) return;
    await api("POST", "/api/memory", { fact: adding.trim() }).catch(errorToast);
    setAdding("");
  };
  const save = async (i: number) => {
    setEditing(null);
    if (value.trim() && value !== memory[i]) await api("PATCH", `/api/memory/${i}`, { fact: value.trim() }).catch(errorToast);
  };

  return (
    <Page
      title="Memory"
      right={
        memory.length > 0 && (
          <button className="btn danger-text" onClick={() => confirm("Forget everything Liquid Agent knows about you?") && api("DELETE", "/api/memory").catch(errorToast)}>
            <Trash2 size={14} /> Forget all
          </button>
        )
      }
    >
      <p className="page-lead">Things Liquid Agent remembers about you. It learns from your chats and uses only what's relevant, so replies stay quick.</p>
      <div className="add-row">
        <input value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add something, like “I live in Lisbon” or “I prefer short answers”" />
        <button className="btn primary" onClick={add} disabled={!adding.trim()}>
          <Plus size={15} /> Add
        </button>
      </div>
      {memory.length ? (
        <div className="list">
          {memory.map((fact, i) => (
            <div key={`${i}-${fact}`} className="list-row">
              <Brain size={15} className="muted" />
              {editing === i ? (
                <input
                  className="list-edit"
                  autoFocus
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onBlur={() => save(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save(i);
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <span className="list-main">{fact}</span>
              )}
              <div className="list-actions">
                <button
                  className="icon-btn"
                  title="Edit"
                  aria-label="Edit"
                  onClick={() => {
                    setValue(fact);
                    setEditing(i);
                  }}
                >
                  {editing === i ? <Check size={14} /> : <Pencil size={14} />}
                </button>
                <button className="icon-btn" title="Forget" aria-label="Forget" onClick={() => api("DELETE", `/api/memory/${i}`).catch(errorToast)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<Brain size={22} />} title="Nothing remembered yet">
          Tell it things in any chat (“remember that my sister is called Ana”) or add them above.
        </Empty>
      )}
    </Page>
  );
}

// ---- Activity ----

export function Activity() {
  const activity = useStore((s) => s.activity);
  const [filter, setFilter] = useState<"all" | "auto" | "you" | "blocked">("all");
  const list = activity.filter((a) =>
    filter === "all" ? true : filter === "auto" ? a.decision?.startsWith("Auto 200M") : filter === "you" ? a.decision?.startsWith("You") : a.ok === false,
  );

  return (
    <Page
      title="Activity"
      right={
        activity.length > 0 && (
          <button className="btn" onClick={() => confirm("Clear the activity log?") && api("DELETE", "/api/activity").catch(errorToast)}>
            <Trash2 size={14} /> Clear
          </button>
        )
      }
    >
      <p className="page-lead">Every action Liquid Agent took on your Mac, and who approved it.</p>
      <div className="filters">
        {(
          [
            ["all", "Everything"],
            ["auto", "Approved by Auto 200M"],
            ["you", "Approved by you"],
            ["blocked", "Failed or denied"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} className={cx("chip", filter === value && "selected")} onClick={() => setFilter(value)}>
            {label}
          </button>
        ))}
      </div>
      {list.length ? (
        <div className="list">
          {list.map((a) => (
            <button key={a.id} className="list-row clickable" onClick={() => go(`#/chat/${a.chatId}`)}>
              <ToolIcon tool={a.tool} />
              <span className="list-main">{a.label}</span>
              {a.decision && (
                <span className={cx("pill", a.ok === false ? "pill-bad" : a.decision.startsWith("Auto 200M") ? "pill-accent" : "pill-muted")}>
                  {a.decision.startsWith("Auto 200M") && <ShieldCheck size={11} />}
                  {a.decision}
                  {a.pDeny !== undefined && ` · ${Math.round((1 - a.pDeny) * 100)}% safe`}
                </span>
              )}
              <span className="muted small nowrap">{timeAgo(a.at)}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty icon={<History size={22} />} title={activity.length ? "Nothing matches" : "No activity yet"}>
          {activity.length ? "Try another filter." : "When Liquid Agent uses your Mac, files or the web, it shows up here."}
        </Empty>
      )}
    </Page>
  );
}

