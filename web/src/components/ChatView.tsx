// A conversation: your messages on the right, Liquid Agent's answers as full
// Markdown with the steps it took, and the message box at the bottom.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  AudioLines,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Lightbulb,
  Monitor,
  Music,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Repeat,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import { api, fileURL } from "../api";
import { speak, stopSpeaking } from "../audio/speak";
import { errorToast, go, modelsReady, useStore } from "../store";
import type { Attachment, Chat, Message } from "../types";
import { chatMarkdown, cx, download, duration, greeting, modelLabel } from "../util";
import { ApprovalDock } from "./ApprovalDock";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { TopBar } from "./Shell";
import { Steps } from "./Steps";
import { Empty, IconButton } from "./ui";

export function ChatView({ chatId }: { chatId?: string }) {
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const loaded = useStore((s) => s.loaded);

  if (chatId && !chat && loaded) {
    return (
      <div className="page">
        <TopBar />
        <Empty icon={<FileText size={22} />} title="This chat isn't here anymore">
          It may have been deleted.
          <button className="btn primary" onClick={() => go("#/")}>
            Start a new chat
          </button>
        </Empty>
      </div>
    );
  }
  if (!chat || !chat.messages.length) return <Welcome chat={chat} />;
  return <Conversation chat={chat} />;
}

// ---- Empty state ----

export const STARTERS = [
  { title: "Tidy my Downloads", prompt: "Look at my Downloads folder and suggest how to tidy it up." },
  { title: "Today's weather", prompt: "What's the weather like today where I am?" },
  { title: "Explain with a table", prompt: "Compare tea and coffee in a table: caffeine, taste, health." },
  { title: "Help me write", prompt: "Help me write a short, friendly message to say thanks to a friend." },
];

function Welcome({ chat }: { chat?: Chat }) {
  const { settings, ideas, parts, routines } = useStore();
  const ready = modelsReady(parts);
  const cards = (ideas.items.length ? ideas.items : STARTERS).slice(0, 4);

  const start = (text: string) => api<Chat>("POST", "/api/chats", { text }).then((c) => go(`#/chat/${c.id}`), errorToast);

  return (
    <div className="page">
      <TopBar />
      <div className="welcome">
        <div className="welcome-inner">
          <h1 className="welcome-title">{greeting(settings?.userName ?? "")}</h1>
          <p className="welcome-sub">{ready ? "What can I help with?" : "Your models are starting up. You can type now."}</p>
          <Composer chat={chat} autoFocus />
          <div className="chips">
            <button className="chip" onClick={() => go("#/voice")}>
              <AudioLines size={15} /> Talk to me
            </button>
            <button className="chip" onClick={() => start("Look at my screen and tell me what you see.")}>
              <Monitor size={15} /> Look at my screen
            </button>
            {routines.slice(0, 2).map((r) => (
              <button key={r.id} className="chip" onClick={() => api<{ id: string }>("POST", `/api/routines/${r.id}/run`).then((c) => go(`#/chat/${c.id}`), errorToast)}>
                <Repeat size={15} /> {r.name}
              </button>
            ))}
          </div>
          <div className="idea-grid">
            {cards.map((idea) => (
              <button key={idea.title} className="idea-card" onClick={() => start(idea.prompt)}>
                <span className="idea-title">{idea.title}</span>
                <span className="idea-prompt">{idea.prompt}</span>
              </button>
            ))}
          </div>
          {ideas.items.length > 0 && (
            <button className="link welcome-more" onClick={() => go("#/foryou")}>
              <Sparkles size={13} /> More ideas for you
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Conversation ----

function Conversation({ chat }: { chat: Chat }) {
  const { running, settings } = useStore();
  const busy = running.includes(chat.id);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const live = useStore((s) => s.live);
  const lastId = chat.messages[chat.messages.length - 1]?.id;

  // Stay at the bottom while text streams in, unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat, live]);

  useLayoutEffect(() => {
    pinned.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.id, lastId]);

  // Read finished answers aloud when that's turned on.
  const seen = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    for (const m of chat.messages) {
      const before = seen.current.get(m.id);
      if (before === "streaming" && m.status === "done" && settings?.speakReplies && !m.voice && m.content) speak(m.id, m.content);
      seen.current.set(m.id, m.status);
    }
  }, [chat, settings?.speakReplies]);

  const onScroll = () => {
    const el = scroller.current!;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = gap < 80;
    setShowJump(gap > 300);
  };

  const remove = async () => {
    if (!confirm(`Delete “${chat.title}”? This can't be undone.`)) return;
    await api("DELETE", `/api/chats/${chat.id}`).catch(errorToast);
    go("#/");
  };

  return (
    <div className="page">
      <TopBar
        title={chat.title}
        onRename={(title) => api("PATCH", `/api/chats/${chat.id}`, { title }).catch(errorToast)}
        menu={[
          {
            label: chat.pinned ? "Unpin" : "Pin",
            icon: chat.pinned ? <PinOff size={15} /> : <Pin size={15} />,
            onClick: () => api("PATCH", `/api/chats/${chat.id}`, { pinned: !chat.pinned }).catch(errorToast),
          },
          { label: "Export as Markdown", icon: <Download size={15} />, onClick: () => download(`${chat.title}.md`, chatMarkdown(chat)) },
          { label: "Continue by voice", icon: <AudioLines size={15} />, onClick: () => go(`#/voice/${chat.id}`) },
          "divider",
          { label: "Delete", icon: <Trash2 size={15} />, danger: true, onClick: remove },
        ]}
      />
      <div className="thread" ref={scroller} onScroll={onScroll}>
        <div className="thread-inner">
          {chat.messages.map((m, i) =>
            m.role === "user" ? (
              <UserMessage key={m.id} chat={chat} message={m} busy={busy} onZoom={setZoom} />
            ) : (
              <AssistantMessage key={m.id} chat={chat} message={m} last={i === chat.messages.length - 1} busy={busy} />
            ),
          )}
        </div>
      </div>
      <div className="dock">
        {showJump && (
          <button
            className="jump"
            onClick={() => {
              pinned.current = true;
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            }}
            aria-label="Scroll to the newest message"
          >
            <ArrowDown size={16} />
          </button>
        )}
        <ApprovalDock chatId={chat.id} />
        <Composer chat={chat} autoFocus />
      </div>
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" />
        </div>
      )}
    </div>
  );
}

function AttachmentView({ file, onZoom }: { file: Attachment; onZoom: (url: string) => void }) {
  if (file.kind === "image") {
    return (
      <button className="msg-image" onClick={() => onZoom(fileURL(file.id))}>
        <img src={fileURL(file.id)} alt={file.name} loading="lazy" />
      </button>
    );
  }
  if (file.kind === "audio") {
    return (
      <div className="msg-file audio">
        <Music size={15} />
        <audio controls src={fileURL(file.id)} preload="none" />
      </div>
    );
  }
  return (
    <a className="msg-file" href={fileURL(file.id)} target="_blank" rel="noreferrer">
      <FileText size={15} />
      <span>{file.name}</span>
    </a>
  );
}

function UserMessage({ chat, message, busy, onZoom }: { chat: Chat; message: Message; busy: boolean; onZoom: (url: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.content);
  const [copied, setCopied] = useState(false);

  const save = () => {
    setEditing(false);
    if (text.trim() && text.trim() !== message.content) api("POST", `/api/chats/${chat.id}/edit`, { messageId: message.id, text }).catch(errorToast);
  };

  return (
    <div className="msg user">
      {!!message.attachments?.length && (
        <div className="msg-attachments">
          {message.attachments.map((a) => (
            <AttachmentView key={a.id} file={a} onZoom={onZoom} />
          ))}
        </div>
      )}
      {editing ? (
        <div className="bubble editing">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="bubble-edit-actions">
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              Send
            </button>
          </div>
        </div>
      ) : (
        message.content && (
          <div className="bubble">
            {message.voice && <AudioLines size={13} className="bubble-voice" />}
            {message.content}
          </div>
        )
      )}
      {!editing && (
        <div className="msg-actions">
          <IconButton
            label={copied ? "Copied" : "Copy"}
            onClick={() => {
              navigator.clipboard.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </IconButton>
          {!busy && (
            <IconButton
              label="Edit"
              onClick={() => {
                setText(message.content);
                setEditing(true);
              }}
            >
              <Pencil size={15} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

/** The model's thinking: a live peek while it thinks, then a line you can open. */
function Thoughts({ text, ms, active }: { text: string; ms?: number; active: boolean }) {
  const [open, setOpen] = useState(false);
  const peek = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (active && peek.current) peek.current.scrollTop = peek.current.scrollHeight;
  }, [text, active]);
  return (
    <div className={cx("thoughts", open && "open", active && "active")}>
      <button className="thoughts-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Lightbulb size={14} />
        <span className={active ? "shimmer" : undefined}>{active ? "Thinking" : ms ? `Thought for ${duration(ms)}` : "Thoughts"}</span>
        <ChevronRight size={14} className="thoughts-chev" />
      </button>
      {(open || active) && (
        <div ref={peek} className={cx("thoughts-body", !open && "peek")}>
          {text}
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ chat, message, last, busy }: { chat: Chat; message: Message; last: boolean; busy: boolean }) {
  const liveText = useStore((s) => s.live[message.id]);
  const liveThought = useStore((s) => s.thoughts[message.id]);
  const speaking = useStore((s) => s.speaking === message.id);
  const [copied, setCopied] = useState(false);
  const streaming = message.status === "streaming";
  const text = streaming ? (liveText ?? message.content) : message.content;
  const steps = message.steps ?? [];
  const waitingOnStep = steps.some((s) => ["pending", "checking", "approval", "running"].includes(s.status));
  const thought = streaming ? (liveThought ?? message.thinking) : message.thinking;
  const thinking = streaming && !text && !waitingOnStep;
  // Still thinking: no new answer text since the latest thought arrived.
  const thinkingNow = thinking && Boolean(liveThought) && liveThought !== message.thinking;

  return (
    <div className={cx("msg assistant", streaming && "streaming")}>
      {message.voice && (
        <div className="voice-tag">
          <AudioLines size={12} /> Voice
        </div>
      )}
      {thought && <Thoughts text={thought} ms={message.thinkingMs} active={thinkingNow} />}
      <Steps steps={steps} working={streaming} ms={message.stats?.ms} />
      {thinking && !thinkingNow && (
        <div className="thinking">
          <span className="thinking-dot" />
          <span className="shimmer">{steps.length ? "Reading the results" : "Thinking"}</span>
        </div>
      )}
      {text && <Markdown streaming={streaming}>{text}</Markdown>}
      {message.interrupted && <div className="msg-note">You interrupted.</div>}
      {message.status === "stopped" && <div className="msg-note">Stopped.</div>}
      {message.status === "error" && (
        <div className="msg-error">
          <span>{message.error || "Something went wrong."}</span>
          {last && !busy && (
            <button className="btn small" onClick={() => api("POST", `/api/chats/${chat.id}/regenerate`).catch(errorToast)}>
              <RefreshCw size={13} /> Try again
            </button>
          )}
        </div>
      )}
      {!streaming && (
        <div className={cx("msg-actions", last && "always")}>
          {message.content && (
            <>
              <IconButton
                label={copied ? "Copied" : "Copy"}
                onClick={() => {
                  navigator.clipboard.writeText(message.content);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </IconButton>
              <IconButton label={speaking ? "Stop reading" : "Read aloud"} active={speaking} onClick={() => (speaking ? stopSpeaking() : speak(message.id, message.content))}>
                {speaking ? <Square size={13} fill="currentColor" /> : <Volume2 size={15} />}
              </IconButton>
            </>
          )}
          {last && !busy && (
            <IconButton label="Try again" onClick={() => api("POST", `/api/chats/${chat.id}/regenerate`).catch(errorToast)}>
              <RefreshCw size={15} />
            </IconButton>
          )}
          {message.model && (
            <span className="msg-stats" title={message.stats ? `${message.stats.tokens} tokens` : undefined}>
              {modelLabel(message.model)}
              {message.stats?.tps ? ` · ${message.stats.tps} tok/s` : ""}
              {message.stats?.ms ? ` · ${duration(message.stats.ms)}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
