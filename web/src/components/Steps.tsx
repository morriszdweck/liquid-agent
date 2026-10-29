// What the agent did while answering: one row per action, open while it works,
// folded into "Worked for 12s" once the answer is in.

import { useEffect, useState } from "react";
import {
  AudioLines,
  Bell,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  Image,
  Keyboard,
  Monitor,
  MousePointerClick,
  Pencil,
  Search,
  ShieldCheck,
  ShieldX,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { Step } from "../types";
import { cx, duration } from "../util";
import { Spinner } from "./ui";

const ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  read_file: FileText,
  write_file: Pencil,
  list_dir: FolderOpen,
  open: ExternalLink,
  web_search: Search,
  fetch_url: Globe,
  browser_goto: Globe,
  browser_read: BookOpen,
  browser_click: MousePointerClick,
  browser_type: Keyboard,
  look_at_screen: Monitor,
  look_at_image: Image,
  transcribe_audio: AudioLines,
  remember: Brain,
  recall: Brain,
  clipboard: Clipboard,
  set_clipboard: ClipboardPaste,
  reminder: Bell,
};

export function ToolIcon({ tool, size = 15 }: { tool: string; size?: number }) {
  const Icon = ICONS[tool] ?? Wrench;
  return <Icon size={size} className="tool-icon" />;
}

const WAITING: Record<string, string> = {
  pending: "Getting ready",
  checking: "Auto 200M is checking",
  approval: "Waiting for you",
  running: "Working",
};

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const busy = step.status in WAITING;
  const denied = step.status === "denied";
  const failed = step.status === "error";
  const expandable = !!step.result || Object.keys(step.args).length > 0;
  const args = Object.entries(step.args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");

  return (
    <div className={cx("step", `status-${step.status}`, open && "open")}>
      {step.note && <div className="step-note">{step.note}</div>}
      <button className="step-row" onClick={() => expandable && setOpen(!open)} disabled={!expandable}>
        <span className="step-state">
          {busy ? <Spinner size={13} /> : denied ? <ShieldX size={14} /> : failed ? <X size={14} /> : <Check size={14} />}
        </span>
        <ToolIcon tool={step.tool} />
        <span className="step-label">{step.label}</span>
        {busy && <span className="step-wait">{WAITING[step.status]}…</span>}
        {!busy && step.decision && (
          <span className={cx("pill", denied ? "pill-bad" : step.decision.startsWith("Auto 200M") ? "pill-accent" : "pill-muted")}>
            {step.decision.startsWith("Auto 200M") && <ShieldCheck size={11} />}
            {step.decision}
          </span>
        )}
        {!busy && step.ms !== undefined && <span className="step-time">{duration(step.ms)}</span>}
        {expandable && <ChevronRight size={14} className="step-chevron" />}
      </button>
      {open && (
        <div className="step-detail">
          {args && <pre className="step-args">{args}</pre>}
          {step.reason && <div className="step-reason">{step.reason}</div>}
          {step.result && <pre className="step-output">{step.result}</pre>}
        </div>
      )}
    </div>
  );
}

export function Steps({ steps, working, ms }: { steps: Step[]; working: boolean; ms?: number }) {
  const [open, setOpen] = useState(working);
  // Open while working, folded once the answer arrives.
  useEffect(() => setOpen(working), [working]);

  if (!steps.length) return null;
  const failed = steps.filter((s) => s.status === "error" || s.status === "denied").length;
  const summary = working
    ? "Working…"
    : `Worked for ${duration(ms ?? 0)} · ${steps.length} ${steps.length === 1 ? "step" : "steps"}${failed ? ` · ${failed} skipped` : ""}`;

  return (
    <div className={cx("steps", open && "open")}>
      <button className="steps-head" onClick={() => setOpen(!open)}>
        {working && <Spinner size={13} />}
        <span>{summary}</span>
        <ChevronRight size={14} className="steps-chevron" />
      </button>
      {open && (
        <div className="steps-list">
          {steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}
