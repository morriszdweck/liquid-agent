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
import { clock, cx, deviceName, timeAgo } from "../util";
import { currentLocale, formatDate, t, type Key } from "../i18n";
import { starters } from "./ChatView";
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
      title={t("sidebar.forYou")}
      right={
        <button className="btn" onClick={refresh} disabled={refreshing || !canRefresh}>
          {refreshing ? <Spinner size={13} /> : <RefreshCw size={14} />} {t("pages.newIdeas")}
        </button>
      }
    >
      <p className="page-lead">{t("pages.forYouLead", { device: deviceName() })}</p>
      <div className="idea-grid big">
        {(ideas.items.length ? ideas.items : starters()).map((idea) => (
          <button key={idea.title} className="idea-card" onClick={() => startChat(idea.prompt)}>
            <Sparkles size={16} className="idea-icon" />
            <span className="idea-title">{idea.title}</span>
            <span className="idea-prompt">{idea.prompt}</span>
          </button>
        ))}
      </div>
      <div className="muted small">
        {ideas.items.length ? t("pages.updated", { time: timeAgo(ideas.at) }) : t("pages.starterNote")}
      </div>

      <section className="section">
        <div className="section-head">
          <h2>{t("pages.knowAboutYou")}</h2>
          <button className="link" onClick={() => go("#/memory")}>
            {t("pages.manage")}
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
          <div className="muted">{t("pages.nothingYet")}</div>
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
        <h2>{t("pages.reminders")}</h2>
      </div>
      <div className="list">
        {reminders.map((r) => (
          <div key={r.id} className="list-row">
            <Bell size={15} className="muted" />
            <span className="list-main">{r.text}</span>
            <span className="muted small">{new Date(r.at).toDateString() === new Date().toDateString() ? clock(r.at) : formatDate(r.at, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            <button className="icon-btn" aria-label={t("pages.cancelReminder")} title={t("pages.cancelReminder")} onClick={() => api("DELETE", `/api/reminders/${r.id}`).catch(errorToast)}>
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
/** The day letters for a schedule, in the current language. Day 0 is Sunday. */
const dayName = (day: number, style: "narrow" | "short") =>
  new Intl.DateTimeFormat(currentLocale(), { weekday: style }).format(new Date(2024, 0, 7 + day));
const DAYS = () => [0, 1, 2, 3, 4, 5, 6].map((d) => dayName(d, "narrow"));

/** "Run by hand", or "Weekdays at 9:00 AM" in the current language. */
function scheduleText(r: Routine) {
  const s = r.schedule;
  if (!s.enabled) return t("routine.byHand");
  const [h, m] = s.time.split(":").map(Number);
  const time = new Date(2000, 0, 1, h, m).toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
  const days = s.days.length === 7 ? t("routine.everyDay") : s.days.join() === "1,2,3,4,5" ? t("routine.weekdays") : s.days.join() === "0,6" ? t("routine.weekends") : s.days.map((d) => dayName(d, "short")).join(", ");
  return t("routine.at", { days, time });
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
      title={t("sidebar.routines")}
      right={
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={15} /> {t("routine.new")}
        </button>
      }
    >
      <p className="page-lead">{t("routine.lead")}</p>
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
                  label={t("routine.runOnSchedule")}
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
                  <button className="icon-btn" title={t("common.edit")} aria-label={t("common.edit")} onClick={() => setEditing(r)}>
                    <Pencil size={14} />
                  </button>
                  <button className="btn small primary" onClick={() => run(r)} disabled={starting === r.id}>
                    {starting === r.id ? <Spinner size={12} /> : <Play size={12} fill="currentColor" />} {t("routine.run")}
                  </button>
                </div>
              </div>
              {r.lastRun > 0 && (
                <button className="routine-last link" onClick={() => r.lastChatId && go(`#/chat/${r.lastChatId}`)}>
                  {t("routine.lastRun", { time: timeAgo(r.lastRun) })}
                </button>
              )}
            </div>
          );
        })}
        <button className="routine-card add" onClick={() => setEditing("new")}>
          <Plus size={20} />
          <span>{t("routine.new")}</span>
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
    if (!name.trim() || !prompt.trim()) return toast(t("routine.needNameAndPrompt"), "error");
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
    if (!routine || !confirm(t("routine.deleteConfirm", { name: routine.name }))) return;
    await api("DELETE", `/api/routines/${routine.id}`).catch(errorToast);
    onClose();
  };

  return (
    <Modal
      title={routine ? t("routine.edit") : t("routine.new")}
      onClose={onClose}
      footer={
        <>
          {routine && (
            <button className="btn danger-text" onClick={remove}>
              <Trash2 size={14} /> {t("common.delete")}
            </button>
          )}
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving && <Spinner size={13} />} {t("common.save")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("routine.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("routine.namePlaceholder")} autoFocus />
      </label>
      <label className="field">
        <span>{t("routine.prompt")}</span>
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("routine.promptPlaceholder")} />
      </label>
      <div className="field">
        <span>{t("routine.look")}</span>
        <div className="picker-row">
          {Object.entries(ROUTINE_ICONS).map(([key, Icon]) => (
            <button key={key} className={cx("swatch", icon === key && "selected")} onClick={() => setIcon(key)} aria-label={t(`routine.icon.${key}` as Key)} style={icon === key ? { background: color, color: "#fff" } : undefined}>
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
          <span>{t("routine.schedule")}</span>
          <Toggle checked={schedule.enabled} onChange={(enabled) => setSchedule({ ...schedule, enabled })} />
        </div>
        {schedule.enabled && (
          <div className="schedule">
            <input type="time" value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
            <div className="days">
              {DAYS().map((d, i) => (
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
      title={t("sidebar.memory")}
      right={
        memory.length > 0 && (
          <button className="btn danger-text" onClick={() => confirm(t("memory.forgetConfirm")) && api("DELETE", "/api/memory").catch(errorToast)}>
            <Trash2 size={14} /> {t("memory.forgetAll")}
          </button>
        )
      }
    >
      <p className="page-lead">{t("memory.lead")}</p>
      <div className="add-row">
        <input value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder={t("memory.addPlaceholder")} />
        <button className="btn primary" onClick={add} disabled={!adding.trim()}>
          <Plus size={15} /> {t("common.add")}
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
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                  onClick={() => {
                    setValue(fact);
                    setEditing(i);
                  }}
                >
                  {editing === i ? <Check size={14} /> : <Pencil size={14} />}
                </button>
                <button className="icon-btn" title={t("memory.forget")} aria-label={t("memory.forget")} onClick={() => api("DELETE", `/api/memory/${i}`).catch(errorToast)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={<Brain size={22} />} title={t("memory.emptyTitle")}>
          {t("memory.emptyBody")}
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
    filter === "all" ? true : filter === "auto" ? a.decisionBy === "guardian" : filter === "you" ? a.decisionBy === "you" : a.ok === false,
  );

  return (
    <Page
      title={t("sidebar.activity")}
      right={
        activity.length > 0 && (
          <button className="btn" onClick={() => confirm(t("activity.clearConfirm")) && api("DELETE", "/api/activity").catch(errorToast)}>
            <Trash2 size={14} /> {t("activity.clear")}
          </button>
        )
      }
    >
      <p className="page-lead">{t("activity.lead", { device: deviceName() })}</p>
      <div className="filters">
        {(
          [
            ["all", t("activity.filter.all")],
            ["auto", t("activity.filter.auto")],
            ["you", t("activity.filter.you")],
            ["blocked", t("activity.filter.blocked")],
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
                <span className={cx("pill", a.ok === false ? "pill-bad" : a.decisionBy === "guardian" ? "pill-accent" : "pill-muted")}>
                  {a.decisionBy === "guardian" && <ShieldCheck size={11} />}
                  {a.decision}
                  {a.pDeny !== undefined && ` · ${t("activity.safe", { n: Math.round((1 - a.pDeny) * 100) })}`}
                </span>
              )}
              <span className="muted small nowrap">{timeAgo(a.at)}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty icon={<History size={22} />} title={activity.length ? t("activity.noMatch") : t("activity.empty")}>
          {activity.length ? t("activity.tryFilter") : t("activity.emptyBody", { device: deviceName() })}
        </Empty>
      )}
    </Page>
  );
}

