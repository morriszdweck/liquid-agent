import { useMemo, useState } from "react";
import {
  AudioLines,
  Brain,
  Download,
  History,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Repeat,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { errorToast, go, part, useStore } from "../store";
import type { Chat } from "../types";
import { IS_MAC, chatMarkdown, cx, download, groupChats } from "../util";
import { IconButton, Menu, Spinner, StatusDot } from "./ui";
import { t } from "../i18n";

export function Logo({ size = 22 }: { size?: number }) {
  return <img src="/icon.svg" width={size} height={size} alt="" className="logo" />;
}

export function Sidebar() {
  const { chats, route, running, parts, settings, sidebarOpen } = useStore();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const activeId = route.page === "chat" ? route.chatId : undefined;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? chats.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
      : chats.filter((c) => c.messages.length);
    return groupChats(list);
  }, [chats, query]);

  const nav = [
    { page: "voice", label: t("sidebar.voiceChat"), icon: <AudioLines size={17} />, hash: "#/voice" },
    { page: "foryou", label: t("sidebar.forYou"), icon: <Sparkles size={17} />, hash: "#/foryou" },
    { page: "routines", label: t("sidebar.routines"), icon: <Repeat size={17} />, hash: "#/routines" },
    { page: "memory", label: t("sidebar.memory"), icon: <Brain size={17} />, hash: "#/memory" },
    { page: "activity", label: t("sidebar.activity"), icon: <History size={17} />, hash: "#/activity" },
  ];

  const small = part(parts, "small");
  const omni = part(parts, "omni");
  const up = [small, omni].filter((p) => p?.status === "running");
  const starting = [small, omni].some((p) => p?.status === "starting" || p?.status === "installing");
  const fetching = parts.find((p) => p.status === "installing");
  const status = fetching
    ? {
        tone: "busy" as const,
        text: fetching.fraction
          ? t("sidebar.downloadingPercent", { what: fetching.title.toLowerCase(), percent: Math.round(fetching.fraction * 100) })
          : t("sidebar.downloading", { what: fetching.title.toLowerCase() }),
      }
    : up.length
      ? { tone: "ok" as const, text: t("sidebar.ready") }
      : starting
          ? { tone: "busy" as const, text: t("sidebar.starting") }
          : { tone: "bad" as const, text: t("sidebar.setUp") };

  return (
    <>
      <div className={cx("sidebar-scrim", sidebarOpen && "open")} onClick={() => useStore.setState({ sidebarOpen: false })} />
      <aside className={cx("sidebar", sidebarOpen && "open")}>
        <div className="sidebar-head">
          <div className="brand">
            <Logo />
            <span>Liquid Agent</span>
          </div>
          <IconButton label={t("sidebar.close")} className="mobile-only" onClick={() => useStore.setState({ sidebarOpen: false })}>
            <X size={18} />
          </IconButton>
        </div>

        <nav className="nav">
          <button className={cx("nav-row", route.page === "chat" && !activeId && "active")} onClick={() => go("#/")}>
            <SquarePen size={17} />
            <span>{t("sidebar.newChat")}</span>
            <kbd>{IS_MAC ? "⌘⇧O" : "Ctrl+Shift+O"}</kbd>
          </button>
          {nav.map((n) => (
            <button key={n.page} className={cx("nav-row", route.page === n.page && "active")} onClick={() => go(n.hash)}>
              {n.icon}
              <span>{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("sidebar.search")} aria-label={t("sidebar.search")} />
          {query && (
            <button className="search-clear" onClick={() => setQuery("")} aria-label={t("sidebar.clearSearch")}>
              <X size={13} />
            </button>
          )}
        </div>

        <div className="recents">
          {groups.length === 0 && <div className="recents-empty">{query ? t("sidebar.noMatches") : t("sidebar.empty")}</div>}
          {groups.map(([label, list]) => (
            <div key={label} className="recents-group">
              <div className="recents-label">{label}</div>
              {list.map((c) => (
                <ChatRow key={c.id} chat={c} active={c.id === activeId} running={running.includes(c.id)} editing={editing === c.id} setEditing={setEditing} />
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <button className="model-status" onClick={() => useStore.setState({ settingsOpen: "downloads" })}>
            {status.tone === "bad" ? <Download size={15} /> : <StatusDot tone={status.tone} />}
            <span>{status.text}</span>
          </button>
          <button className="profile" onClick={() => useStore.setState({ settingsOpen: "general" })}>
            <span className="avatar">{(settings?.userName || t("common.you")).slice(0, 1).toUpperCase()}</span>
            <span className="profile-name">{settings?.userName || t("sidebar.settings")}</span>
            <SettingsIcon size={16} />
          </button>
        </div>
      </aside>
    </>
  );
}

function ChatRow({
  chat,
  active,
  running,
  editing,
  setEditing,
}: {
  chat: Chat;
  active: boolean;
  running: boolean;
  editing: boolean;
  setEditing: (id: string | null) => void;
}) {
  const [title, setTitle] = useState(chat.title);
  const save = () => {
    setEditing(null);
    if (title.trim() && title !== chat.title) api("PATCH", `/api/chats/${chat.id}`, { title }).catch(errorToast);
  };
  const remove = async () => {
    if (!confirm(t("chat.deleteConfirm", { title: chat.title }))) return;
    await api("DELETE", `/api/chats/${chat.id}`).catch(errorToast);
    if (active) go("#/");
  };

  if (editing) {
    return (
      <div className="chat-row editing">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className={cx("chat-row", active && "active")}>
      <button className="chat-row-main" onClick={() => go(`#/chat/${chat.id}`)} title={chat.title}>
        {chat.source === "voice" && <AudioLines size={13} className="chat-row-icon" />}
        {chat.source === "routine" && <Repeat size={13} className="chat-row-icon" />}
        <span className="chat-row-title">{chat.title}</span>
        {running && <Spinner size={12} />}
      </button>
      <Menu
        align="right"
        trigger={(open, toggle) => (
          <button className={cx("chat-row-more", open && "open")} onClick={toggle} aria-label={t("sidebar.chatOptions")}>
            <MoreHorizontal size={15} />
          </button>
        )}
        items={[
          {
            label: t("common.rename"),
            icon: <Pencil size={15} />,
            onClick: () => {
              setTitle(chat.title);
              setEditing(chat.id);
            },
          },
          {
            label: chat.pinned ? t("sidebar.unpin") : t("sidebar.pin"),
            icon: chat.pinned ? <PinOff size={15} /> : <Pin size={15} />,
            onClick: () => api("PATCH", `/api/chats/${chat.id}`, { pinned: !chat.pinned }).catch(errorToast),
          },
          { label: t("sidebar.exportMarkdown"), icon: <Download size={15} />, onClick: () => download(`${chat.title}.md`, chatMarkdown(chat)) },
          "divider",
          { label: t("common.delete"), icon: <Trash2 size={15} />, danger: true, onClick: remove },
        ]}
      />
    </div>
  );
}
