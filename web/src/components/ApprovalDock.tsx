// "Can I do this?" card that sits above the message box while an action waits for you.

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api } from "../api";
import { errorToast, go, pendingApprovals, useStore } from "../store";
import { Spinner } from "./ui";
import { ToolIcon } from "./Steps";

export function ApprovalDock({ chatId, showChat }: { chatId?: string; showChat?: boolean }) {
  const chats = useStore((s) => s.chats);
  const pending = pendingApprovals(chats, chatId);
  const [sending, setSending] = useState<string | null>(null);
  const first = pending[0];

  useEffect(() => {
    if (!first) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Enter") {
        e.preventDefault();
        answer(first.step.id, true);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        answer(first.step.id, false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [first?.step.id]);

  if (!first) return null;
  const { chat, step } = first;
  const args = Object.entries(step.args).filter(([, v]) => v !== undefined && v !== "");

  async function answer(id: string, approve: boolean) {
    setSending(id);
    try {
      await api("POST", `/api/approvals/${id}`, { approve });
    } catch (e) {
      errorToast(e);
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="approval" role="alertdialog" aria-label="Approval needed">
      <div className="approval-head">
        <span className="approval-icon">
          <ShieldAlert size={16} />
        </span>
        <div className="approval-title">
          <strong>Allow this?</strong>
          {pending.length > 1 && <span className="approval-count">1 of {pending.length}</span>}
        </div>
        {showChat && (
          <button className="link" onClick={() => go(`#/chat/${chat.id}`)}>
            {chat.title}
          </button>
        )}
      </div>
      <div className="approval-action">
        <ToolIcon tool={step.tool} />
        <span>{step.label}</span>
      </div>
      {args.length > 0 && (
        <pre className="approval-args">
          {args.map(([k, v]) => (args.length === 1 ? String(v) : `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)).join("\n")}
        </pre>
      )}
      {step.reason && <div className="approval-reason">{step.reason}</div>}
      <div className="approval-buttons">
        <button className="btn" disabled={!!sending} onClick={() => answer(step.id, false)}>
          Don't allow
        </button>
        <button className="btn primary" disabled={!!sending} onClick={() => answer(step.id, true)}>
          {sending === step.id ? <Spinner size={13} /> : null}
          Allow
          <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
