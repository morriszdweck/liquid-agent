// The message box: text, files and pictures, a screenshot of your screen,
// dictation through Omni, and a button into voice chat.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  FileText,
  Mic,
  Monitor,
  Music,
  Paperclip,
  Plus,
  ShieldCheck,
  ShieldQuestion,
  Square,
  X,
  Zap,
} from "lucide-react";
import { api, fileURL, transcribe, upload } from "../api";
import { Mic as Microphone, wav } from "../audio/capture";
import { errorToast, go, part, toast, useStore } from "../store";
import type { ApprovalMode, Attachment, Chat } from "../types";
import { captureScreen, cx, prepareImage } from "../util";
import { Menu, Spinner } from "./ui";

type Pending = { key: string; name: string; kind: Attachment["kind"]; preview?: string; uploaded?: Attachment; failed?: boolean };

export const MODES: { value: ApprovalMode; label: string; detail: string; icon: JSX.Element }[] = [
  { value: "askAlways", label: "Ask for Approval", detail: "Asks you before every action.", icon: <ShieldQuestion size={15} /> },
  { value: "approveForMe", label: "Approve for Me", detail: "Auto 200M approves safe actions and asks about the rest.", icon: <ShieldCheck size={15} /> },
  { value: "fullAuto", label: "Full Auto", detail: "Runs everything. Risky commands still ask.", icon: <Zap size={15} /> },
];

const kindOf = (file: File): Attachment["kind"] =>
  file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : /^text\/|json|xml|javascript/.test(file.type) ? "text" : "other";

export function fill(text: string) {
  window.dispatchEvent(new CustomEvent("la:fill", { detail: text }));
}

export function Composer({ chat, autoFocus }: { chat?: Chat; autoFocus?: boolean }) {
  const { running, settings, parts } = useStore();
  // The draft survives a reload, such as the one after the server restarts.
  const draftKey = `la:draft:${chat?.id ?? "new"}`;
  const [text, setText] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState<null | "on" | "busy">(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const mic = useRef<{ mic: Microphone; chunks: Int16Array[]; started: number } | null>(null);
  const busy = chat ? running.includes(chat.id) : false;
  const omniUp = part(parts, "omni")?.status === "running";

  const keepDraft = useCallback(
    (value: string) => {
      try {
        if (value) sessionStorage.setItem(draftKey, value);
        else sessionStorage.removeItem(draftKey);
      } catch {
        // Storage can be off; the draft just won't survive a reload.
      }
    },
    [draftKey],
  );
  useEffect(() => {
    if (text) keepDraft(text);
  }, [text, keepDraft]);

  // Grow the box with its content, and again whenever its width changes.
  const fit = useCallback(() => {
    const el = area.current;
    if (!el || !el.clientWidth) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);
  useLayoutEffect(fit, [text, recording, fit]);
  useEffect(() => {
    const el = area.current?.parentElement;
    if (!el) return;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width !== width) {
        width = entry.contentRect.width;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, recording]);

  useEffect(() => {
    const onFill = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      requestAnimationFrame(() => area.current?.focus());
    };
    window.addEventListener("la:fill", onFill);
    return () => window.removeEventListener("la:fill", onFill);
  }, []);

  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus, chat?.id]);

  const addFiles = useCallback(async (list: File[] | Blob[], names?: string[]) => {
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const file = raw instanceof File ? raw : new File([raw], names?.[i] ?? "file", { type: raw.type });
      if (file.size > 25 * 1024 * 1024) {
        toast(`${file.name} is too big (25 MB at most).`, "error");
        continue;
      }
      const key = crypto.randomUUID();
      const kind = kindOf(file);
      const preview = kind === "image" ? URL.createObjectURL(file) : undefined;
      setFiles((f) => [...f, { key, name: file.name, kind, preview }]);
      try {
        const { blob, name } = kind === "image" ? await prepareImage(file) : { blob: file, name: file.name };
        const uploaded: Attachment = await upload(blob, name);
        setFiles((f) => f.map((p) => (p.key === key ? { ...p, uploaded, kind: uploaded.kind } : p)));
      } catch (e) {
        errorToast(e);
        setFiles((f) => f.filter((p) => p.key !== key));
      }
    }
  }, []);

  // Drop files anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  const uploading = files.some((f) => !f.uploaded);
  const canSend = !busy && !uploading && (text.trim().length > 0 || files.length > 0) && recording === null;

  async function send() {
    if (!canSend) return;
    const body = { text: text.trim(), attachments: files.map((f) => f.uploaded!.id) };
    setText("");
    setFiles([]);
    try {
      if (chat) await api("POST", `/api/chats/${chat.id}/send`, body);
      else {
        const created = await api<Chat>("POST", "/api/chats", body);
        go(`#/chat/${created.id}`);
      }
      keepDraft("");
    } catch (e) {
      setText(body.text);
      errorToast(e);
    }
  }

  async function lookAtScreen() {
    if (!omniUp) return toast("Seeing your screen needs Eyes and ears (LFM3 Omni 2B). Set it up in Settings → Downloads.", "error");
    try {
      const shot = await captureScreen();
      await addFiles([shot], [`Screen ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.jpg`]);
      if (!text.trim()) setText("What's on my screen?");
      area.current?.focus();
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") errorToast(e);
    }
  }

  async function startDictation() {
    if (!omniUp) return toast("Dictation needs Eyes and ears (LFM3 Omni 2B). Set it up in Settings → Downloads.", "error");
    const chunks: Int16Array[] = [];
    const m = new Microphone(16000, (f) => {
      chunks.push(f.pcm);
      setLevel(f.rms);
    });
    try {
      await m.start();
    } catch {
      return toast("I can't use the microphone. Allow it in your browser's site settings.", "error");
    }
    mic.current = { mic: m, chunks, started: Date.now() };
    setElapsed(0);
    setRecording("on");
  }

  useEffect(() => {
    if (recording !== "on") return;
    const t = setInterval(() => setElapsed(Date.now() - (mic.current?.started ?? Date.now())), 200);
    return () => clearInterval(t);
  }, [recording]);

  async function stopDictation(keep: boolean) {
    const current = mic.current;
    mic.current = null;
    current?.mic.stop();
    if (!keep || !current || current.chunks.length < 10) {
      setRecording(null);
      return;
    }
    setRecording("busy");
    try {
      const said = await transcribe(wav(current.chunks, 16000));
      if (said) setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said));
      else toast("I didn't catch that. Try again a little closer to the mic.");
    } catch (e) {
      errorToast(e);
    } finally {
      setRecording(null);
      area.current?.focus();
    }
  }

  const mode = MODES.find((m) => m.value === settings?.approvalMode) ?? MODES[1];
  const needsOmni = files.some((f) => f.kind === "image" || f.kind === "audio");
  const lastModel = chat?.messages.filter((m) => m.role === "assistant").at(-1)?.model;
  const modelHint = needsOmni ? "LFM3 Omni 2B" : lastModel === "omni" && chat?.messages.slice(-4).some((m) => m.attachments?.some((a) => a.kind !== "text")) ? "LFM3 Omni 2B" : "LFM3 1.7B";

  return (
    <div className="composer-wrap">
      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={28} />
          <div>Drop files to add them</div>
        </div>
      )}
      <div className={cx("composer", recording && "recording")}>
        {files.length > 0 && (
          <div className="attachments">
            {files.map((f) => (
              <div key={f.key} className={cx("attachment", f.kind === "image" && "image")}>
                {f.kind === "image" ? (
                  <img src={f.preview ?? (f.uploaded ? fileURL(f.uploaded.id) : undefined)} alt={f.name} />
                ) : (
                  <>
                    <span className="attachment-icon">{f.kind === "audio" ? <Music size={16} /> : <FileText size={16} />}</span>
                    <span className="attachment-name">{f.name}</span>
                  </>
                )}
                {!f.uploaded && (
                  <span className="attachment-busy">
                    <Spinner size={14} />
                  </span>
                )}
                <button className="attachment-remove" onClick={() => setFiles((all) => all.filter((x) => x.key !== f.key))} aria-label={`Remove ${f.name}`}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {recording ? (
          <div className="dictation">
            <span className="rec-dot" />
            <span className="rec-time">{recording === "busy" ? "Writing it down…" : `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, "0")}`}</span>
            <div className="rec-level">
              {Array.from({ length: 28 }, (_, i) => (
                <span key={i} style={{ height: `${Math.max(3, Math.min(22, level * 400 * (0.5 + Math.abs(Math.sin(i * 1.7 + elapsed / 180)))))}px` }} />
              ))}
            </div>
            {recording === "busy" ? (
              <Spinner />
            ) : (
              <>
                <button className="round-btn ghost" onClick={() => stopDictation(false)} aria-label="Cancel dictation">
                  <X size={16} />
                </button>
                <button className="round-btn primary" onClick={() => stopDictation(true)} aria-label="Finish dictation">
                  <Check size={16} />
                </button>
              </>
            )}
          </div>
        ) : (
          <textarea
            ref={area}
            value={text}
            rows={1}
            placeholder={chat?.messages.length ? "Reply to Liquid Agent…" : "Ask anything, or tell me what to do on your Mac"}
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value) keepDraft("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
          />
        )}

        {!recording && (
          <div className="composer-row">
            <Menu
              side="top"
              trigger={(open, toggle) => (
                <button className={cx("round-btn ghost", open && "active")} onClick={toggle} aria-label="Add">
                  <Plus size={18} />
                </button>
              )}
              items={[
                { label: "Add photos and files", icon: <Paperclip size={15} />, onClick: () => picker.current?.click() },
                { label: "Look at my screen", icon: <Monitor size={15} />, onClick: lookAtScreen, hint: "Omni" },
              ]}
            />
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <div className="composer-spacer" />
            <button className="round-btn ghost" onClick={startDictation} aria-label="Dictate" title="Dictate (Omni)">
              <Mic size={17} />
            </button>
            {busy ? (
              <button className="round-btn primary" onClick={() => api("POST", `/api/chats/${chat!.id}/stop`).catch(errorToast)} aria-label="Stop" title="Stop">
                <Square size={13} fill="currentColor" />
              </button>
            ) : text.trim() || files.length ? (
              <button className="round-btn primary" onClick={send} disabled={!canSend} aria-label="Send" title="Send">
                {uploading ? <Spinner size={14} /> : <ArrowUp size={18} />}
              </button>
            ) : (
              <button className="round-btn primary voice" onClick={() => go(chat ? `#/voice/${chat.id}` : "#/voice")} aria-label="Voice chat" title="Voice chat (Omni)">
                <AudioLines size={18} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="composer-foot">
        <Menu
          side="top"
          width={300}
          trigger={(open, toggle) => (
            <button className={cx("foot-btn", open && "active")} onClick={toggle}>
              {mode.icon}
              {mode.label}
              <ChevronDown size={13} />
            </button>
          )}
          items={MODES.map((m) => ({
            label: m.label,
            icon: m.icon,
            detail: m.detail,
            checked: m.value === mode.value,
            onClick: () => api("PATCH", "/api/settings", { approvalMode: m.value }).catch(errorToast),
          }))}
        />
        <span className="foot-model" title="Liquid Agent picks the model for you">
          Auto · {modelHint}
        </span>
      </div>
    </div>
  );
}
