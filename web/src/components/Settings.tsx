// Settings, the one-click downloads, and the first-run setup screen.

import { useState } from "react";
import {
  AudioLines,
  Bell,
  Brain,
  Check,
  Cpu,
  Download,
  Eye,
  FolderOpen,
  Globe,
  Link2,
  Monitor,
  Moon,
  Play,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Square,
  Sun,
  Trash2,
  User,
  Volume2,
} from "lucide-react";
import { api } from "../api";
import { speak, stopSpeaking } from "../audio/speak";
import { errorToast, toast, useStore } from "../store";
import type { ModelResolution, Part, Settings as SettingsType } from "../types";
import { IS_MAC, cx, deviceName, timeAgo } from "../util";
import { LOCALES, setLocale, t } from "../i18n";
import { modeNote, modes } from "./Composer";
import { Logo } from "./Sidebar";
import { Modal, Progress, Segmented, Spinner, StatusDot, Toggle } from "./ui";

const patch = (body: Partial<SettingsType>) => api("PATCH", "/api/settings", body).catch(errorToast);

const PART_ICONS: Record<Part["id"], JSX.Element> = {
  engine: <Cpu size={18} />,
  small: <Brain size={18} />,
  omni: <Eye size={18} />,
  guardian: <Shield size={18} />,
  browser: <Globe size={18} />,
};

const TABS = (): { id: string; label: string; icon: JSX.Element }[] => [
  { id: "general", label: t("settings.tab.general"), icon: <User size={15} /> },
  { id: "voice", label: t("settings.tab.voice"), icon: <AudioLines size={15} /> },
  { id: "safety", label: t("settings.tab.safety"), icon: <Shield size={15} /> },
  { id: "downloads", label: t("settings.tab.downloads"), icon: <Download size={15} /> },
  { id: "advanced", label: t("settings.tab.advanced"), icon: <SlidersHorizontal size={15} /> },
];

export function SettingsModal() {
  const tab = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  if (!tab || !settings) return null;
  const close = () => useStore.setState({ settingsOpen: null });

  return (
    <Modal title={t("settings.title")} onClose={close} wide>
      <div className="settings">
        <nav className="settings-nav">
          {TABS().map((item) => (
            <button key={item.id} className={cx("nav-row", tab === item.id && "active")} onClick={() => useStore.setState({ settingsOpen: item.id })}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "general" && <General settings={settings} />}
          {tab === "voice" && <Voice settings={settings} />}
          {tab === "safety" && <Safety settings={settings} />}
          {tab === "downloads" && <Downloads />}
          {tab === "advanced" && <Advanced settings={settings} />}
        </div>
      </div>
    </Modal>
  );
}

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {detail && <div className="setting-detail">{detail}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** A text box that saves when you leave it. */
function SavedInput({ value, onSave, placeholder, type = "text", width }: { value: string; onSave: (v: string) => void; placeholder?: string; type?: string; width?: number }) {
  const [text, setText] = useState(value);
  return (
    <input
      className="input"
      type={type}
      value={text}
      placeholder={placeholder}
      style={width ? { width } : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onSave(text)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function General({ settings }: { settings: SettingsType }) {
  return (
    <>
      <h3>{t("settings.tab.general")}</h3>
      <Row title={t("settings.name")} detail={t("settings.nameDetail")}>
        <SavedInput value={settings.userName} placeholder={t("settings.namePlaceholder")} onSave={(userName) => patch({ userName })} />
      </Row>
      <Row title={t("settings.language")} detail={t("settings.languageDetail")}>
        <select className="input" value={settings.language ?? "auto"} onChange={(e) => patch({ language: e.target.value }).then(() => setLocale(e.target.value))}>
          <option value="auto">{t("settings.language.auto")}</option>
          {LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </Row>
      <Row title={t("settings.personality")} detail={t("settings.personalityDetail")}>
        <select className="input" value={settings.personality} onChange={(e) => patch({ personality: e.target.value as SettingsType["personality"] })}>
          <option value="friendly">{t("settings.personality.friendly")}</option>
          <option value="concise">{t("settings.personality.concise")}</option>
          <option value="playful">{t("settings.personality.playful")}</option>
          <option value="professional">{t("settings.personality.professional")}</option>
        </select>
      </Row>
      <Row title={t("settings.appearance")}>
        <Segmented
          size="sm"
          value={settings.theme}
          onChange={(theme) => patch({ theme })}
          options={[
            { value: "system", label: t("settings.theme.auto"), icon: <Monitor size={13} /> },
            { value: "light", label: t("settings.theme.light"), icon: <Sun size={13} /> },
            { value: "dark", label: t("settings.theme.dark"), icon: <Moon size={13} /> },
          ]}
        />
      </Row>
      <Row title={t("settings.workspace")} detail={t("settings.workspaceDetail")}>
        <SavedInput value={settings.workspace} placeholder="~" onSave={(workspace) => patch({ workspace })} width={200} />
      </Row>
      <Row title={t("settings.notifications")} detail={t("settings.notificationsDetail")}>
        <NotificationButton />
      </Row>
      <Updates settings={settings} />
    </>
  );
}

/** The version, and whether it keeps itself up to date. */
function Updates({ settings }: { settings: SettingsType }) {
  const update = useStore((s) => s.update);
  if (!update) return null;
  if (!update.managed)
    return (
      <Row title={t("settings.version", { version: update.version })} detail={update.build ? t("settings.versionManaged") : t("settings.versionSource")}>
        <span className="muted small">{update.build ? t("settings.build", { build: update.build }) : t("settings.fromSource")}</span>
      </Row>
    );
  const working = update.state === "checking" || update.state === "downloading" || update.state === "updating";
  const status = {
    idle: update.checkedAt ? t("settings.upToDate", { time: timeAgo(update.checkedAt) }) : settings.autoUpdate ? t("settings.checksEvery") : t("settings.checkWhenever"),
    checking: t("settings.checking"),
    downloading: t("settings.downloading", { percent: update.progress }),
    ready: settings.autoUpdate ? t("settings.readyAuto") : t("settings.ready"),
    updating: t("settings.restarting"),
    error: update.error,
  }[update.state];
  return (
    <>
      <Row title={t("settings.autoUpdate")} detail={t("settings.autoUpdateDetail")}>
        <Toggle checked={settings.autoUpdate} onChange={(autoUpdate) => patch({ autoUpdate })} />
      </Row>
      <Row title={t("settings.versionBuild", { version: update.version, build: update.build ?? "" })} detail={status}>
        {update.state === "ready" ? (
          <button className="btn primary" onClick={() => api("POST", "/api/update/apply").catch(errorToast)}>
            <Download size={14} /> {t("settings.updateNow")}
          </button>
        ) : (
          <button className="btn" disabled={working} onClick={() => api("POST", "/api/update/check").catch(errorToast)}>
            {working ? <Spinner size={13} /> : <RotateCcw size={14} />} {t("settings.checkNow")}
          </button>
        )}
      </Row>
    </>
  );
}

function NotificationButton() {
  const [state, setState] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  if (state === "granted")
    return (
      <span className="pill pill-accent">
        <Check size={12} /> {t("settings.on")}
      </span>
    );
  if (state === "unsupported" || state === "denied") return <span className="muted small">{state === "denied" ? t("settings.blocked") : t("settings.notAvailable")}</span>;
  return (
    <button className="btn" onClick={() => Notification.requestPermission().then(setState)}>
      <Bell size={14} /> {t("settings.turnOn")}
    </button>
  );
}

function Voice({ settings }: { settings: SettingsType }) {
  const speaking = useStore((s) => s.speaking === "preview");
  return (
    <>
      <h3>{t("settings.tab.voice")}</h3>
      <p className="muted">{t("settings.voiceIntro", { device: deviceName() })}</p>
      <Row title={t("settings.voiceCallMode")} detail={t("settings.voiceCallModeDetail")}>
        <select className="input" value={settings.voiceCallMode ?? "realtime"} onChange={(e) => patch({ voiceCallMode: e.target.value as "realtime" | "highQuality" })}>
          <option value="realtime">{t("settings.voiceModeRealtime")}</option>
          <option value="highQuality">{t("settings.voiceModeQuality")}</option>
        </select>
      </Row>
      <p className="muted">{settings.voiceCallMode === "highQuality" ? t("settings.voiceQualityEffective", { language: settings.realtimeLanguage !== "auto" ? settings.realtimeLanguage : settings.language, voice: settings.voice }) : t("settings.voiceRealtimeEffective", { language: settings.realtimeLanguage !== "auto" ? settings.realtimeLanguage : settings.language })}</p>
      <Row title={t("settings.voice")} detail={t("settings.readAloudVoiceDetail")}>
        <Segmented
          size="sm"
          value={settings.voice}
          onChange={(voice) => patch({ voice })}
          options={[
            { value: "female", label: t("settings.voiceA") },
            { value: "male", label: t("settings.voiceB") },
          ]}
        />
        <button className="btn" onClick={() => (speaking ? stopSpeaking() : speak("preview", t("settings.previewText", { device: deviceName() })))}>
          {speaking ? <Square size={12} fill="currentColor" /> : <Volume2 size={14} />} {speaking ? t("common.stop") : t("settings.hearIt")}
        </button>
      </Row>
      <Row title={t("settings.ttsLanguage")} detail={t("settings.ttsLanguageDetail") + " " + t("settings.ttsCallNote")}>
        <select className="input" value={settings.ttsLanguage ?? "auto"} onChange={(e) => patch({ ttsLanguage: e.target.value })}>
          {[["auto", t("settings.ttsAuto")], ["default", t("settings.ttsDefault")], ["ar", "العربية"], ["da", "Dansk"], ["de", "Deutsch"], ["el", "Ελληνικά"], ["en", "English (US)"], ["en-gb", "English (UK)"], ["es", "Español"], ["fi", "Suomi"], ["fr", "Français"], ["he", "עברית"], ["it", "Italiano"], ["ja", "日本語"], ["ko", "한국어"], ["nl", "Nederlands"], ["pl", "Polski"], ["pt", "Português"], ["sv", "Svenska"], ["tr", "Türkçe"], ["zh", "中文"]].map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </Row>
      <Row title={t("settings.asrLanguage")} detail={settings.voiceCallMode === "highQuality" ? t("settings.asrQualityDetail") : t("settings.asrLanguageDetail") + " " + t("settings.asrCallAuto")}>
        <select className="input" value={settings.asrLanguage ?? "auto"} onChange={(e) => patch({ asrLanguage: e.target.value })}>
          {[["auto", t("settings.realtimeAuto")], ["en", "English"], ["es", "Español"], ["pt", "Português"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"], ["ja", "日本語"], ["zh", "中文"]].map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </Row>
      <Row title={t("settings.realtimeLanguage")} detail={settings.voiceCallMode === "highQuality" ? t("settings.callQualityLanguageDetail") : t("settings.realtimeLanguageDetail")}>
        <select className="input" value={settings.realtimeLanguage ?? "auto"} onChange={(e) => patch({ realtimeLanguage: e.target.value })}>
          {[["auto", t("settings.realtimeAuto")], ["en", "English"], ["en-gb", "English (UK)"], ["es", "Español"], ["pt", "Português"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"], ["ja", "日本語"], ["zh", "中文"]].map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </Row>
      <Row title={t("settings.verifySpeech")} detail={t("settings.verifySpeechDetail")}><Toggle checked={settings.verifySpeech} onChange={(verifySpeech) => patch({ verifySpeech })} /></Row>
      <Row title={t("settings.readAloud")} detail={t("settings.readAloudDetail")}>
        <Toggle checked={settings.speakReplies} onChange={(speakReplies) => patch({ speakReplies })} />
      </Row>
    </>
  );
}

function Safety({ settings }: { settings: SettingsType }) {
  const guardian = useStore((s) => s.parts.find((p) => p.id === "guardian"));
  const wanted = useStore((s) => s.guardianWanted);
  return (
    <>
      <h3>{t("settings.tab.safety")}</h3>
      <p className="muted">{t("settings.safetyIntro", { device: deviceName() })}</p>
      <div className="mode-cards">
        {modes().map((m) => (
          <button key={m.value} className={cx("mode-card", settings.approvalMode === m.value && "selected")} onClick={() => patch({ approvalMode: m.value })}>
            <span className="mode-icon">{m.icon}</span>
            <span className="mode-title">{m.label}</span>
            <span className="mode-detail">{m.detail}</span>
            {m.value === "approveForMe" && modeNote(guardian, wanted) && <span className="mode-need">{modeNote(guardian, wanted)}</span>}
            {settings.approvalMode === m.value && <Check size={15} className="mode-check" />}
          </button>
        ))}
      </div>
      {guardian && (wanted || (settings.approvalMode === "approveForMe" && guardian.status !== "running")) && (
        <div className="parts">
          <PartRow part={guardian} />
        </div>
      )}
      {settings.approvalMode === "approveForMe" && guardian?.status !== "running" && !wanted && (
        <div className="notice">{t("settings.safetyNotRunning")}</div>
      )}
      <Row title={t("settings.careful")} detail={t("settings.carefulDetail", { percent: Math.round((1 - settings.guardianThreshold) * 100) })}>
        <input
          type="range"
          min={0.1}
          max={0.9}
          step={0.05}
          value={1 - settings.guardianThreshold}
          onChange={(e) => patch({ guardianThreshold: Math.round((1 - Number(e.target.value)) * 100) / 100 })}
        />
      </Row>
      <p className="muted small">{t("settings.wipeNote")}</p>
    </>
  );
}

export function PartRow({ part }: { part: Part }) {
  const busy = useStore((s) => s.busy);
  const act = (path: string, body?: unknown) => api("POST", path, body).catch(errorToast);
  const changing = busy || part.status === "installing" || part.status === "starting";
  const tone = part.status === "running" ? "ok" : part.status === "failed" ? "bad" : part.status === "installing" || part.status === "starting" ? "busy" : "off";
  const label = {
    missing: t("part.missing"),
    installing: part.text || t("part.downloading"),
    installed: t("part.downloaded"),
    starting: t("part.starting"),
    running: t("part.ready"),
    failed: part.error || t("part.failed"),
  }[part.status];
  const note = part.queued && part.status !== "installing" ? t("part.waiting") : part.live ? t("part.keepsWorking", { label }) : label;

  return (
    <div className={cx("part", `status-${part.status}`)}>
      <span className="part-icon">{PART_ICONS[part.id]}</span>
      <div className="part-text">
        <div className="part-title">
          {part.title} <span className="muted small">· {part.size}{part.version ? ` · ${part.version}` : ""}</span>
        </div>
        <div className="part-detail">{part.detail}</div>
        {part.quants && (
          <label className="part-size">
            <span>{t("part.size")}</span>
            <select
              className="input"
              value={part.quant}
              disabled={changing}
              title={changing ? t("part.waitDownload") : undefined}
              onChange={(e) =>
                part.custom
                  ? api("POST", "/api/models/custom/quant", { file: e.target.value }).catch(errorToast)
                  : patch({ [`${part.id}Quant`]: e.target.value } as Partial<SettingsType>)
              }
            >
              {part.quants.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.quant ? `${q.quant} · ` : ""}
                  {quantLabel(q.id, q.label)} · {q.size}
                  {q.note ? ` · ${quantNote(q.id, q.note)}` : ""}
                  {q.onDisk ? " ✓" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className={cx("part-status", part.status === "failed" && "bad")}>
          <StatusDot tone={part.queued ? "busy" : tone} /> {note}{part.deviceFallback === "cpu" && (part.status === "running" || part.status === "starting") ? ` · ${t("part.cpuFallback")}` : ""}
        </div>
        {part.status === "installing" && <Progress value={part.fraction} />}
      </div>
      <div className="part-actions">
        {part.status === "missing" && !part.queued && (
          <button className="btn primary" onClick={() => act("/api/parts/install", { ids: part.id === "engine" ? ["engine"] : ["engine", part.id] })}>
            <Download size={14} /> {t("part.get")}
          </button>
        )}
        {part.status === "failed" && !part.queued && (
          <button className="btn primary" onClick={() => act("/api/parts/install", { ids: [part.id] })}>
            <RotateCcw size={14} /> {t("part.tryAgain")}
          </button>
        )}
        {part.status === "installed" && part.id !== "engine" && (
          <button className="btn" onClick={() => act(`/api/parts/${part.id}/start`)}>
            <Play size={13} /> {t("part.start")}
          </button>
        )}
        {(part.status === "running" || part.status === "starting") && part.id !== "engine" && (
          <button className="btn" onClick={() => act(`/api/parts/${part.id}/stop`)}>
            <Square size={11} fill="currentColor" /> {t("common.stop")}
          </button>
        )}
        {part.status === "installing" && <button className="btn" onClick={() => act("/api/parts/cancel")}>{t("common.cancel")}</button>}
        {(part.status === "installed" || part.status === "running" || part.status === "failed") && !(part.id === "small" && part.custom) && (
          <button
            className="icon-btn"
            title={t("part.remove")}
            aria-label={t("part.remove")}
            onClick={() => confirm(t("part.removeConfirm", { title: part.title })) && act(`/api/parts/${part.id}/remove`)}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function CustomModelModal({ part, onClose }: { part: Part; onClose: () => void }) {
  const [link, setLink] = useState(part.custom ? `https://huggingface.co/${part.custom.repo}` : "");
  const [result, setResult] = useState<ModelResolution | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const find = async () => {
    if (!link.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const found = await api<ModelResolution>("POST", "/api/models/resolve", { link: link.trim() });
      setResult(found);
      setSelected(found.requested ?? found.recommended);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!result || !selected) return;
    setBusy(true);
    setError("");
    try {
      await api("POST", "/api/models/custom", { link: link.trim(), file: selected });
      toast(t("custom.downloading"));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={part.custom ? t("custom.change") : t("custom.add")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!result || !selected || busy} onClick={add}>
            <Download size={14} /> {t("custom.use")}
          </button>
        </>
      }
    >
      <p className="muted">
        {t("custom.intro", { device: deviceName() })}
      </p>
      <div className="notice">{t("custom.notice")}</div>
      <label className="field">
        <span>{t("custom.link")}</span>
        <input
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setResult(null);
            setSelected("");
          }}
          onKeyDown={(e) => e.key === "Enter" && find()}
          placeholder="https://huggingface.co/org/model"
          autoFocus
        />
      </label>
      <div className="h3-row">
        <span className="muted small">{t("custom.hfNote")}</span>
        <button className="btn" disabled={!link.trim() || busy} onClick={find}>
          {busy ? t("custom.looking") : t("custom.findSizes")}
        </button>
      </div>
      {error && <div className="notice bad">{error}</div>}
      {result && (
        <>
          <Row title={result.label} detail={`${result.repo}${result.gated ? t("custom.gated") : ""}`}>
            <a className="btn" href={result.licenseUrl ?? `https://huggingface.co/${result.repo}`} target="_blank" rel="noreferrer">
              {result.license ? t("custom.license", { license: result.license }) : t("custom.modelPage")}
            </a>
          </Row>
          <Row title={t("custom.size")} detail={t("custom.sizeDetail")}>
            <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {result.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.quant} · {v.size}
                </option>
              ))}
            </select>
          </Row>
          {result.warning && <div className="notice">{result.warning}</div>}
        </>
      )}
    </Modal>
  );
}

function Downloads() {
  const parts = useStore((s) => s.parts);
  const busy = useStore((s) => s.busy);
  const missing = parts.filter((p) => p.status === "missing" || p.status === "failed").map((p) => p.id);
  return (
    <>
      <div className="h3-row">
        <h3>{t("settings.tab.downloads")}</h3>
        {missing.length > 0 && (
          <button className="btn primary" disabled={busy} onClick={() => api("POST", "/api/parts/install", { ids: ["engine", ...missing.filter((id) => id !== "engine")] }).catch(errorToast)}>
            <Download size={14} /> {t("downloads.getAll")}
          </button>
        )}
      </div>
      <p className="muted">{t("downloads.intro", { device: deviceName() })}</p>
      <div className="parts">
        {parts.map((p) => (
          <PartRow key={p.id} part={p} />
        ))}
      </div>
      <button className="btn" onClick={() => api("POST", "/api/reveal").catch(errorToast)}>
        <FolderOpen size={14} /> {IS_MAC ? t("downloads.finder") : t("downloads.showFiles")}
      </button>
    </>
  );
}

/** Swaps the Everyday brain for a GGUF model from Hugging Face. Lives in Advanced, away from Downloads and first-run setup. */
function EverydayModel() {
  const part = useStore((s) => s.parts.find((p) => p.id === "small"));
  const busy = useStore((s) => s.busy);
  const [open, setOpen] = useState(false);
  if (!part) return null;
  const custom = part.custom;
  const changing = busy || part.status === "installing" || part.status === "starting";
  const useBuiltIn = () => {
    if (!confirm(t("everyday.stopConfirm", { model: custom?.label ?? t("everyday.thisModel") }))) return;
    api("DELETE", "/api/models/custom").catch(errorToast);
  };
  return (
    <>
      <Row
        title={t("everyday.title")}
        detail={
          custom
            ? `${custom.label} · huggingface.co/${custom.repo}${custom.license ? ` · ${custom.license}` : ""}`
            : t("everyday.builtIn")
        }
      >
        <button className="btn" disabled={changing} onClick={() => setOpen(true)}>
          <Link2 size={13} /> {custom ? t("everyday.change") : t("everyday.useHF")}
        </button>
        {custom && (
          <button className="btn" disabled={changing} onClick={useBuiltIn}>
            {t("everyday.useBuiltIn")}
          </button>
        )}
      </Row>
      {open && <CustomModelModal part={part} onClose={() => setOpen(false)} />}
    </>
  );
}

function Advanced({ settings }: { settings: SettingsType }) {
  const num = (key: keyof SettingsType, min: number, max: number) => (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) return toast(t("advanced.pickNumber", { min, max }), "error");
    patch({ [key]: n } as Partial<SettingsType>);
  };
  return (
    <>
      <h3>{t("settings.tab.advanced")}</h3>
      <EverydayModel />
      <ResourceDiagnostics />
      <CapabilityDiagnostics />
      <Row title={t("advanced.context")} detail={t("advanced.contextDetail")}>
        <SavedInput type="number" width={110} value={String(settings.contextBudget)} onSave={num("contextBudget", 1000, 14000)} />
      </Row>
      <Row title={t("advanced.startupMode")} detail={`${t("advanced.startupModeDetail")} ${t("advanced.startupWarmup")} ${t("advanced.startupHybridDetail")}`}>
        <select className="input" value={settings.startupMode ?? "auto"} onChange={(e) => patch({ startupMode: e.target.value as SettingsType["startupMode"] })}>
          <option value="auto">{t("advanced.startupAuto")}</option><option value="hybrid">{t("advanced.startupHybrid")}</option><option value="dual">{t("advanced.startupDual")}</option><option value="single-omni">{t("advanced.startupSingle")}</option>
        </select>
      </Row>
      <Row title={t("advanced.projector")} detail={t("advanced.projectorDetail")}>
        <select className="input" value={settings.omniProjector ?? "Q8_0"} onChange={(e) => patch({ omniProjector: e.target.value as SettingsType["omniProjector"] })}>
          <option value="Q8_0">Q8_0 · ~507 MB</option><option value="Q4_K_M">Q4_K_M · ~292 MB</option>
        </select>
      </Row>
      <Row title={t("advanced.cacheLimit")} detail={t("advanced.cacheLimitDetail")}>
        <select className="input" value={settings.promptCacheMiB ?? 256} onChange={(e) => patch({ promptCacheMiB: Number(e.target.value) })}>
          <option value={0}>0 MiB</option><option value={256}>256 MiB</option><option value={1024}>1,024 MiB</option><option value={8192}>8,192 MiB</option>
        </select>
      </Row>
      <Row title={t("advanced.idleSleep")} detail={t("advanced.idleSleepDetail")}>
        <select className="input" value={settings.idleSleepMinutes ?? 0} onChange={(e) => patch({ idleSleepMinutes: Number(e.target.value) })}>
          <option value={0}>{t("advanced.idleSleepOff")}</option><option value={5}>5 min</option><option value={15}>15 min</option><option value={30}>30 min</option>
        </select>
      </Row>
      <Row title={t("advanced.gpuLayers")} detail={t("advanced.gpuLayersDetail")}>
        <select className="input" value={settings.gpuLayers ?? 99} onChange={(e) => patch({ gpuLayers: Number(e.target.value) })}>
          <option value={0}>0</option><option value={16}>16</option><option value={99}>{t("advanced.gpuLayersAll")}</option>
        </select>
      </Row>
      <Row title={t("advanced.modelContext")} detail={t("advanced.modelContextDetail")}>
        <select className="input" value={settings.modelContext ?? 16384} onChange={(e) => patch({ modelContext: Number(e.target.value) })}>
          <option value={8192}>8,192</option><option value={16384}>16,384</option><option value={32768}>32,768</option>
        </select>
      </Row>
      <Row title={t("advanced.omniSlots")} detail={t("advanced.omniSlotsDetail")}>
        <select className="input" value={settings.omniSlots ?? 1} onChange={(e) => patch({ omniSlots: Number(e.target.value) as 1 | 2 })}>
          <option value={1}>1</option><option value={2}>2</option>
        </select>
      </Row>
      <Row title={t("advanced.toolOutput")} detail={t("advanced.toolOutputDetail")}>
        <SavedInput type="number" width={110} value={String(settings.toolOutputLimit)} onSave={num("toolOutputLimit", 500, 20000)} />
      </Row>
      <Row title={t("advanced.maxSteps")}>
        <SavedInput type="number" width={110} value={String(settings.maxSteps)} onSave={num("maxSteps", 1, 20)} />
      </Row>
      <Row title={t("advanced.creativity")} detail={t("advanced.creativityDetail", { temp: settings.temperature.toFixed(2) })}>
        <input type="range" min={0} max={1} step={0.05} value={settings.temperature} onChange={(e) => patch({ temperature: Number(e.target.value) })} />
      </Row>
      <Row title={t("advanced.deleteAll")} detail={t("advanced.deleteAllDetail")}>
        <button className="btn danger-text" onClick={() => confirm(t("advanced.deleteAllConfirm")) && api("DELETE", "/api/chats").then(() => (location.hash = "#/"), errorToast)}>
          <Trash2 size={14} /> {t("advanced.deleteAllButton")}
        </button>
      </Row>
    </>
  );
}

type Diagnostics = {
  system: { availableBytes: number | null; swapTotalBytes: number | null; swapFreeBytes: number | null };
  processes: Record<string, { pid: number; rssBytes?: number | null; pssBytes?: number | null; privateBytes?: number | null; swapBytes?: number | null }>;
  engineProperties: Record<string, { build?: string | null; sleeping?: boolean | null; slots?: number | null; context?: number | null } | null>;
};

function ResourceDiagnostics() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const mib = (bytes?: number | null) => bytes == null ? "—" : `${(bytes / 1048576).toFixed(0)} MiB`;
  return <Row title={t("advanced.resources")} detail={t("advanced.resourcesDetail")}>
    <button className="btn" onClick={() => api<Diagnostics>("GET", "/api/diagnostics").then(setData, errorToast)}>{t("advanced.resourcesRefresh")}</button>
    {data && <div className="muted small">
      <div>{t("advanced.available")}: {mib(data.system.availableBytes)} · {t("advanced.swap")}: {data.system.swapTotalBytes == null || data.system.swapFreeBytes == null ? "—" : mib(data.system.swapTotalBytes - data.system.swapFreeBytes)}</div>
      {Object.entries(data.processes).map(([id,p]) => <div key={id}>{id} ({p.pid}): PSS {mib(p.pssBytes)} · RSS {mib(p.rssBytes)} · {t("advanced.privateMemory")} {mib(p.privateBytes)} · {t("advanced.swap")} {mib(p.swapBytes)}</div>)}
      {Object.entries(data.engineProperties).filter(([,p]) => p != null).map(([id,p]) => <div key={id}>{id}: {p?.build ?? "—"} · {t("advanced.engineContext")}: {p?.context ?? "—"} · {t("advanced.engineSlots")}: {p?.slots ?? "—"} · {t("advanced.engineSleeping")}: {p?.sleeping == null ? "—" : p.sleeping ? t("settings.on") : t("advanced.idleSleepOff")}</div>)}
    </div>}
  </Row>;
}

function CapabilityDiagnostics() {
  const [result, setResult] = useState<{ spanishWav: boolean; realtimeHandshake: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useStore((s) => s.parts.some((p) => p.id === "omni" && p.status === "running"));
  const check = async () => {
    setBusy(true); setResult(null);
    try { setResult(await api("POST", "/api/capabilities/omni")); } catch (error) { errorToast(error); } finally { setBusy(false); }
  };
  return <Row title={t("advanced.capabilities")} detail={t("advanced.capabilitiesDetail")}>
    <button className="btn" disabled={!running || busy} onClick={check}>{busy ? <Spinner size={14} /> : null} {t("advanced.capabilitiesRun")}</button>
    {result && <div className="muted small">
      <div>{t("advanced.capabilitiesSpeech")}: {result.spanishWav ? t("advanced.capabilitiesPassed") : t("advanced.capabilitiesFailed")}</div>
      <div>{t("advanced.capabilitiesRealtime")}: {result.realtimeHandshake ? t("advanced.capabilitiesPassed") : t("advanced.capabilitiesFailed")}</div>
    </div>}
  </Row>;
}

// ---- First run ----

const SIZES = [
  { id: "small", label: () => t("setup.size.small"), detail: () => t("setup.size.smallDetail"), small: "QAD-Q4_0", omni: "Q4_0" },
  { id: "balanced", label: () => t("setup.size.balanced"), detail: () => t("setup.size.balancedDetail"), small: "Q4_K_M", omni: "Q4_K_M" },
  { id: "best", label: () => t("setup.size.best"), detail: () => t("setup.size.bestDetail"), small: "Q8_0", omni: "Q8_0" },
] as const;
type SizeId = (typeof SIZES)[number]["id"];

/** Quant names and notes, in the language of the screen. The server's own text is the fallback. */
const QUANT_TEXT: Record<string, { label: () => string; note?: () => string }> = {
  "QAD-Q4_0": { label: () => t("quant.smallest"), note: () => t("quant.smallestNote") },
  Q4_K_M: { label: () => t("quant.balanced"), note: () => t("quant.recommended") },
  Q5_K_M: { label: () => t("quant.sharper") },
  Q6_K: { label: () => t("quant.sharperStill") },
  Q8_0: { label: () => t("quant.best"), note: () => t("quant.bestNote") },
  F16: { label: () => t("quant.full"), note: () => t("quant.fullNote") },
};
const quantLabel = (id: string, fallback: string) => QUANT_TEXT[id]?.label() ?? fallback;
const quantNote = (id: string, fallback: string) => QUANT_TEXT[id]?.note?.() ?? fallback;

const PLANS = {
  all: ["engine", "small", "omni", "guardian", "browser"],
  text: ["engine", "small"],
} as const;

const gbText = (bytes: number) => t("size.gigabytes", { n: (bytes / 1e9).toFixed(1) });

/** Bytes a plan downloads with a given size, from what the server says each part weighs. */
function planBytes(parts: Part[], ids: readonly Part["id"][], size: (typeof SIZES)[number]) {
  return ids.reduce((sum, id) => {
    const p = parts.find((x) => x.id === id);
    if (!p || p.status === "installed" || p.status === "running") return sum;
    if (!p.quants) return sum + (p.bytes ?? 0);
    const current = p.quants.find((q) => q.id === p.quant);
    const chosen = p.quants.find((q) => q.id === (id === "small" ? size.small : size.omni));
    // Omni's bytes include its audio and vision projector on top of the weights.
    return sum + (chosen?.bytes ?? 0) + ((p.bytes ?? 0) - (current?.bytes ?? 0));
  }, 0);
}

export function Setup() {
  const { parts, busy, settings, machine } = useStore();
  const memoryGB = machine.memoryGB;
  const availableGB = machine.availableMemoryBytes == null ? null : machine.availableMemoryBytes / (1024 ** 3);
  const suggested: SizeId = availableGB != null ? (availableGB >= 12 ? "best" : availableGB < 4 ? "small" : "balanced") : memoryGB >= 16 ? "best" : memoryGB > 0 && memoryGB < 8 ? "small" : "balanced";
  const [plan, setPlan] = useState<keyof typeof PLANS>("all");
  const [sizeId, setSizeId] = useState<SizeId>(suggested);
  const [name, setName] = useState(settings?.userName ?? "");
  const size = SIZES.find((x) => x.id === sizeId)!;
  const device = deviceName();
  const installing = busy || parts.some((p) => p.status === "installing");
  const failed = parts.filter((p) => p.status === "failed");

  const go = async () => {
    try {
      await api("PATCH", "/api/settings", { userName: name.trim(), smallQuant: size.small, omniQuant: size.omni });
      await api("POST", "/api/parts/install", { ids: PLANS[plan] });
      // Approve for Me turns itself on once Auto 150M is ready.
      if (plan === "all") await api("PATCH", "/api/settings", { approvalMode: "approveForMe" });
    } catch (e) {
      errorToast(e);
    }
  };

  if (installing || failed.length) {
    const shown = parts.filter((p) => p.status !== "missing" || p.queued);
    const total = shown.reduce((sum, p) => sum + p.bytes, 0);
    const done = shown.reduce(
      (sum, p) => sum + (p.status === "installing" ? (p.fraction ?? 0) * p.bytes : ["installed", "starting", "running"].includes(p.status) ? p.bytes : 0),
      0,
    );
    const current = shown.find((p) => p.status === "installing");
    return (
      <div className="setup">
        <div className="setup-card">
          <Logo size={44} />
          <h1>{installing ? t("setup.settingUp") : t("setup.almostThere")}</h1>
          {installing ? (
            <>
              <p className="muted">
                {current ? `${t("setup.getting", { what: current.title.toLowerCase() })} ` : ""}
                {t("setup.leaveOpen")}
              </p>
              <div className="setup-progress">
                <Progress value={total ? done / total : undefined} />
                <span className="muted small">
                  {t("setup.ofTotal", { done: gbText(done), total: gbText(total) })}
                </span>
              </div>
            </>
          ) : (
            <p className="muted">{t("setup.didntDownload")}</p>
          )}
          <div className="parts compact">
            {shown.map((p) => (
              <PartRow key={p.id} part={p} />
            ))}
          </div>
          {installing ? (
            <button className="btn" onClick={() => api("POST", "/api/parts/cancel").catch(errorToast)}>
              {t("setup.pause")}
            </button>
          ) : (
            <button className="btn primary big" onClick={() => api("POST", "/api/parts/install", { ids: failed.map((p) => p.id) }).catch(errorToast)}>
              <RotateCcw size={16} /> {t("part.tryAgain")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <Logo size={52} />
        <h1>{t("setup.welcome")}</h1>
        <p className="muted">{t("setup.intro", { device })}</p>
        <label className="field">
          <span>{t("setup.callYou")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("setup.namePlaceholder")} />
        </label>
        <div className="plan-cards">
          <button className={cx("plan-card", plan === "all" && "selected")} onClick={() => setPlan("all")}>
            <span className="plan-head">
              <strong>{t("setup.plan.everything")}</strong>
              <span className="pill pill-accent">{t("setup.plan.recommended")}</span>
            </span>
            <span className="plan-size">{t("setup.plan.size", { size: gbText(planBytes(parts, PLANS.all, size)) })}</span>
            <ul>
              <li>{t("setup.plan.chat", { device })}</li>
              <li>{t("setup.plan.voice")}</li>
              <li>{t("setup.plan.guardian")}</li>
              <li>{t("setup.plan.web")}</li>
            </ul>
          </button>
          <button className={cx("plan-card", plan === "text" && "selected")} onClick={() => setPlan("text")}>
            <span className="plan-head">
              <strong>{t("setup.plan.justChat")}</strong>
            </span>
            <span className="plan-size">{t("setup.plan.size", { size: gbText(planBytes(parts, PLANS.text, size)) })}</span>
            <ul>
              <li>{t("setup.plan.chat", { device })}</li>
              <li>{t("setup.plan.later")}</li>
            </ul>
          </button>
        </div>
        <div className="size-pick">
          <div className="size-pick-head">
            <span>{t("setup.modelSize")}</span>
            {memoryGB > 0 && <span className="muted small">{t("setup.memory", { device, gb: memoryGB })}{availableGB != null && ` · ${t("setup.availableMemory", { gb: availableGB.toFixed(1) })}`}</span>}
          </div>
          <div className="size-options">
            {SIZES.map((x) => (
              <button key={x.id} className={cx("size-option", sizeId === x.id && "selected")} onClick={() => setSizeId(x.id)}>
                <span className="size-label">
                  {x.label()}
                  {x.id === suggested && <span className="pill pill-accent">{t("setup.forThis", { device })}</span>}
                </span>
                <span className="size-detail">{x.detail()}</span>
              </button>
            ))}
          </div>
          <span className="muted small">{t("setup.changeLater")}</span>
        </div>
        <button className="btn primary big wide" onClick={go}>
          <Download size={17} /> {t("setup.download")}
        </button>
        <p className="muted small">{t("setup.footer")}</p>
      </div>
    </div>
  );
}
