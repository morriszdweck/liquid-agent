// The message box: text, files and pictures, a screenshot of your screen,
// dictation through Omni, and a button into voice chat.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  AudioLines,
  Check,
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
import type { ApprovalMode, Attachment, Chat, Part } from "../types";
import { captureScreen, clock, cx, IS_MAC, prepareImage } from "../util";
import { Menu, Spinner } from "./ui";
import { t } from "../i18n";

/** Five minutes of 16 kHz speech: about 10 MB of WAV, well inside the server's upload limit. */
const DICTATION_LIMIT = 16000 * 300;

type Pending = { key: string; name: string; kind: Attachment["kind"]; preview?: string; uploaded?: Attachment; failed?: boolean };

export const modes = (): { value: ApprovalMode; label: string; detail: string; icon: JSX.Element }[] => [
  { value: "askAlways", label: t("mode.ask"), detail: t("mode.askDetail"), icon: <ShieldQuestion size={15} /> },
  { value: "approveForMe", label: t("mode.approve"), detail: t("mode.approveDetail"), icon: <ShieldCheck size={15} /> },
  { value: "fullAuto", label: t("mode.full"), detail: t("mode.fullDetail"), icon: <Zap size={15} /> },
];

/** Approve for Me needs Auto 150M. Says what picking it will do when Auto 150M isn't ready yet. */
export function modeNote(guardian: Part | undefined, wanted: boolean) {
  if (guardian?.status === "running") return null;
  if (wanted) return guardian?.status === "failed" ? t("composer.guardianFailed") : t("composer.guardianGetting");
  if (guardian?.status === "installed" || guardian?.status === "starting") return t("composer.guardianStarts");
  return t("composer.guardianDownloads", { size: guardian?.size ?? t("composer.aboutGigabytes", { n: "1.1" }) });
}

const kindOf = (file: File): Attachment["kind"] =>
  file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : /^text\/|json|xml|javascript/.test(file.type) ? "text" : "other";

export function fill(text: string) {
  window.dispatchEvent(new CustomEvent("la:fill", { detail: text }));
}

export function Composer({ chat, autoFocus }: { chat?: Chat; autoFocus?: boolean }) {
  const { running, settings, parts, guardianWanted } = useStore();
  const guardian = parts.find((p) => p.id === "guardian");
  const customBrain = parts.find((p) => p.id === "small")?.custom;
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
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState<null | "on" | "busy">(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const mic = useRef<{ mic: Microphone; chunks: Int16Array[]; started: number } | null>(null);
  const busy = chat ? running.includes(chat.id) : false;
  const omni = part(parts, "omni");
  const omniUp = omni?.status === "running" || omni?.onDemand;

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
    if (sendingRef.current) return;
    for (let i = 0; i < list.length; i++) {
      const raw = list[i];
      const file = raw instanceof File ? raw : new File([raw], names?.[i] ?? "file", { type: raw.type });
      if (file.size > 25 * 1024 * 1024) {
        toast(t("composer.tooBig", { name: file.name }), "error");
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
  const canSend = !busy && !sending && !uploading && (text.trim().length > 0 || files.length > 0) && recording === null;

  async function send() {
    if (!canSend || sendingRef.current) return;
    const body = { text: text.trim(), attachments: files.map((f) => f.uploaded!.id) };
    sendingRef.current = true;
    setSending(true);
    try {
      if (chat) await api("POST", `/api/chats/${chat.id}/send`, body);
      else {
        const created = await api<Chat>("POST", "/api/chats", body);
        go(`#/chat/${created.id}`);
      }
      setText("");
      setFiles([]);
      keepDraft("");
    } catch (e) {
      errorToast(e);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function lookAtScreen() {
    if (sendingRef.current) return;
    if (!omniUp) return toast(t("composer.needsEyes"), "error");
    try {
      const shot = await captureScreen();
      await addFiles([shot], [t("composer.screenFile", { time: clock(Date.now()) })]);
      if (!text.trim()) setText(t("composer.screenPrompt"));
      area.current?.focus();
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") errorToast(e);
    }
  }

  async function startDictation() {
    if (sendingRef.current) return;
    if (!omniUp) return toast(t("composer.dictationNeedsEyes"), "error");
    const chunks: Int16Array[] = [];
    let heard = 0;
    const m = new Microphone(16000, (f) => {
      chunks.push(f.pcm);
      heard += f.pcm.length;
      setLevel(f.rms);
      // Long recordings outgrow the upload limit and the model's context, so a dictation ends at the cap and is written down.
      if (heard >= DICTATION_LIMIT) void stopDictation(true);
    });
    try {
      await m.start();
    } catch {
      return toast(t("composer.micBlocked"), "error");
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
      else toast(t("composer.didntCatch"));
    } catch (e) {
      errorToast(e);
    } finally {
      setRecording(null);
      area.current?.focus();
    }
  }

  const mode = modes().find((m) => m.value === settings?.approvalMode) ?? modes()[0];
  const device = IS_MAC ? t("device.mac") : t("device.computer");

  return (
    <div className="composer-wrap">
      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={28} />
          <div>{t("composer.drop")}</div>
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
                <button className="attachment-remove" disabled={sending} onClick={() => setFiles((all) => all.filter((x) => x.key !== f.key))} aria-label={t("composer.remove", { name: f.name })}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {sending && <div className="muted small" role="status"><Spinner size={12} /> {t("composer.preparing")}</div>}
        {recording ? (
          <div className="dictation">
            <span className="rec-dot" />
            <span className="rec-time">{recording === "busy" ? t("composer.writingDown") : `${Math.floor(elapsed / 60000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, "0")}`}</span>
            <div className="rec-level">
              {Array.from({ length: 28 }, (_, i) => (
                <span key={i} style={{ height: `${Math.max(3, Math.min(22, level * 400 * (0.5 + Math.abs(Math.sin(i * 1.7 + elapsed / 180)))))}px` }} />
              ))}
            </div>
            {recording === "busy" ? (
              <Spinner />
            ) : (
              <>
                <button className="round-btn ghost" onClick={() => stopDictation(false)} aria-label={t("composer.cancelDictation")}>
                  <X size={16} />
                </button>
                <button className="round-btn primary" onClick={() => stopDictation(true)} aria-label={t("composer.finishDictation")}>
                  <Check size={16} />
                </button>
              </>
            )}
          </div>
        ) : (
          <textarea
            ref={area}
            disabled={sending}
            value={text}
            rows={1}
            placeholder={chat?.messages.length ? t("composer.reply") : t("composer.ask", { device })}
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
                <button className={cx("round-btn ghost", open && "active")} onClick={toggle} aria-label={t("composer.add")}>
                  <Plus size={18} />
                </button>
              )}
              items={[
                { label: t("composer.addFiles"), icon: <Paperclip size={15} />, onClick: () => picker.current?.click() },
                { label: t("composer.lookAtScreen"), icon: <Monitor size={15} />, onClick: lookAtScreen },
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
            <Menu
              side="top"
              width={300}
              trigger={(open, toggle) => (
                <button
                  className={cx("mode-btn", open && "active")}
                  onClick={toggle}
                  aria-label={t("composer.permissions", { mode: mode.label })}
                  title={guardianWanted ? t("composer.approveWhenReady") : t("composer.permissionsTitle")}
                >
                  {guardianWanted && guardian?.status !== "failed" ? <Spinner size={14} /> : mode.icon}
                  <span>{mode.label}</span>
                </button>
              )}
              items={modes().map((m) => ({
                label: m.label,
                icon: m.icon,
                detail:
                  (m.value === "approveForMe" && modeNote(guardian, guardianWanted)) ||
                  (m.value === "fullAuto" && customBrain && t("composer.customBrainNote")) ||
                  m.detail,
                checked: m.value === mode.value,
                onClick: () => api("PATCH", "/api/settings", { approvalMode: m.value }).catch(errorToast),
              }))}
            />
            <div className="composer-spacer" />
            <button className="round-btn ghost" onClick={startDictation} aria-label={t("composer.dictate")} title={t("composer.dictate")}>
              <Mic size={17} />
            </button>
            {busy ? (
              <button className="round-btn primary" onClick={() => api("POST", `/api/chats/${chat!.id}/stop`).catch(errorToast)} aria-label={t("common.stop")} title={t("common.stop")}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : text.trim() || files.length ? (
              <button className="round-btn primary" onClick={send} disabled={!canSend} aria-label={t("common.send")} title={t("common.send")}>
                {uploading || sending ? <Spinner size={14} /> : <ArrowUp size={18} />}
              </button>
            ) : (
              <button className="round-btn primary voice" onClick={() => go(chat ? `#/voice/${chat.id}` : "#/voice")} aria-label={t("sidebar.voiceChat")} title={t("sidebar.voiceChat")}>
                <AudioLines size={18} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
