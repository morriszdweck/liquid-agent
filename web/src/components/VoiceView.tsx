// Voice chat with LFM3 Omni 2B: it hears you, thinks and talks back in one
// model. Talk over it any time to interrupt. With the camera on, it also gets a
// frame when you start talking and every few seconds while you talk.

import { useEffect, useRef, useState } from "react";
import { AudioLines, Keyboard, Mic, MicOff, PhoneOff, Send, Video, VideoOff, Wrench } from "lucide-react";
import { socketURL } from "../api";
import { Camera, Mic as Microphone, SpeechDetector } from "../audio/capture";
import { Player } from "../audio/player";
import { stopSpeaking } from "../audio/speak";
import { go, part, useStore } from "../store";
import { cx, deviceName } from "../util";
import { localizeServerError, t, type Key } from "../i18n";
import { ApprovalDock } from "./ApprovalDock";
import { TopBar } from "./Shell";
import { Empty, Spinner } from "./ui";

type Session = { ws: WebSocket; mic?: Microphone; player?: Player; camera?: Camera; lastFrame: number; level: number };
const FRAME_EVERY_MS = 4000;

type Phase = "idle" | "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "working" | "ended";

const PHASE_KEY: Record<Phase, Key> = {
  idle: "voice.phase.idle",
  connecting: "voice.phase.connecting",
  listening: "voice.phase.listening",
  hearing: "voice.phase.listening",
  thinking: "voice.phase.thinking",
  speaking: "voice.phase.speaking",
  working: "voice.phase.working",
  ended: "voice.phase.ended",
};

export function VoiceView({ chatId }: { chatId?: string }) {
  const omni = useStore((s) => part(s.parts, "omni"));
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [you, setYou] = useState("");
  const [agentText, setAgentText] = useState("");
  const [tool, setTool] = useState<{ label: string; status: string } | null>(null);
  const [muted, setMuted] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [video, setVideo] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [sessionChat, setSessionChat] = useState<string | undefined>(chatId);
  const hasTranscript = useStore((s) => s.chats.some((c) => c.id === sessionChat && c.messages.length > 0));
  const orb = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const session = useRef<Session | null>(null);
  const ready = omni?.status === "running" || !!omni?.onDemand;

  function end() {
    const s = session.current;
    session.current = null;
    if (!s) return;
    try {
      s.ws.readyState === WebSocket.OPEN && s.ws.send(JSON.stringify({ type: "stop" }));
    } catch {}
    s.ws.close();
    s.mic?.stop();
    s.player?.close();
    s.camera?.stop();
    setVideo(false);
  }

  /** Sends what the camera sees now, if it's on. */
  function sendFrame(s: Session) {
    const image = s.camera?.snapshot();
    if (!image || s.ws.readyState !== WebSocket.OPEN) return;
    s.lastFrame = Date.now();
    s.ws.send(JSON.stringify({ type: "frame", image }));
  }

  async function toggleVideo() {
    const s = session.current;
    if (!s) return;
    if (s.camera) {
      s.camera.stop();
      s.camera = undefined;
      setVideo(false);
      return;
    }
    const camera = new Camera();
    try {
      await camera.start();
    } catch {
      camera.stop();
      setError(t("voice.cameraBlocked"));
      return;
    }
    if (session.current !== s) return camera.stop();
    s.camera = camera;
    setError("");
    setVideo(true);
  }

  async function start() {
    if (session.current) return;
    stopSpeaking();
    setError("");
    setYou("");
    setAgentText("");
    setTool(null);
    setPhase("connecting");
    const ws = new WebSocket(socketURL("/voice"));
    ws.binaryType = "arraybuffer";
    const s: Session = { ws, lastFrame: 0, level: 0 };
    session.current = s;
    let streaming = false;

    ws.onopen = () => ws.send(JSON.stringify({ type: "start", chatId }));
    ws.onclose = () => {
      if (session.current === s) {
        end();
        setPhase("ended");
      }
    };
    ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        s.player?.push(event.data);
        return;
      }
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "ready": {
          setCameraAvailable(msg.cameraAvailable === true);
          setSessionChat(msg.chatId);
          if (msg.chatId !== chatId) history.replaceState(null, "", `#/voice/${msg.chatId}`);
          s.player = new Player(msg.outputRate);
          await s.player.resume();
          const detector = new SpeechDetector({
            start(preroll) {
              // Talking over the reply interrupts it.
              if (s.player?.playing || streaming) {
                ws.send(JSON.stringify({ type: "cancel" }));
                s.player?.flush();
              }
              streaming = true;
              setPhase("hearing");
              sendFrame(s);
              for (const f of preroll) ws.send(f);
            },
            frame(pcm) {
              ws.send(pcm);
              if (s.camera && Date.now() - s.lastFrame > FRAME_EVERY_MS) sendFrame(s);
            },
            end() {
              ws.send(JSON.stringify({ type: "commit" }));
              setPhase("thinking");
            },
          });
          s.mic = new Microphone(msg.inputRate, (frame) => {
            s.level = frame.rms;
            // Raise the bar while it talks so its own voice doesn't count as you.
            detector.push(frame, s.player?.playing ? 2.5 : 1);
          });
          try {
            await s.mic.start();
          } catch {
            setError(t("voice.micBlocked"));
            end();
            setPhase("ended");
            return;
          }
          setPhase("listening");
          break;
        }
        case "state":
          if (msg.state === "listening") streaming = false;
          setPhase((p) => (p === "hearing" && msg.state === "listening" ? p : msg.state));
          break;
        case "user":
          setYou(msg.text);
          break;
        case "assistant":
          setAgentText(msg.text);
          break;
        case "tool":
          setTool({ label: msg.label, status: msg.status });
          if (msg.status !== "pending" && msg.status !== "running" && msg.status !== "approval") setTimeout(() => setTool(null), 2500);
          break;
        case "turn.done":
          streaming = false;
          break;
        case "error":
          setError(localizeServerError(msg.message));
          break;
      }
    };
  }

  // Start right away when you got here by clicking; browsers need a click before sound can play.
  useEffect(() => {
    if (ready && (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) start();
    return end;
  }, [ready]);

  useEffect(() => {
    if (session.current?.mic) session.current.mic.muted = muted;
  }, [muted]);

  useEffect(() => {
    if (preview.current) preview.current.srcObject = (video && session.current?.camera?.stream) || null;
  }, [video]);

  // The orb breathes with whoever is talking.
  useEffect(() => {
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      const s = session.current;
      const level = s ? Math.max(s.player?.level() ?? 0, muted ? 0 : s.level * 1.4) : 0;
      smooth = smooth * 0.75 + Math.min(level * 6, 1) * 0.25;
      orb.current?.style.setProperty("--level", smooth.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [muted]);

  const sendTyped = () => {
    const text = typed.trim();
    if (!text || !session.current) return;
    session.current.player?.flush();
    sendFrame(session.current);
    session.current.ws.send(JSON.stringify({ type: "text", text }));
    setYou(text);
    setAgentText("");
    setTyped("");
  };

  if (!ready) {
    const waking = omni?.status === "starting";
    return (
      <div className="page">
        <TopBar title={t("voice.title")} />
        <Empty icon={waking ? <Spinner size={22} /> : <AudioLines size={22} />} title={waking ? t("voice.gettingReady") : t("voice.needsEyes")}>
          {waking ? (
            t("voice.fewSeconds")
          ) : (
            <>
              {t("voice.listensOn", { device: deviceName() })}
              <button className="btn primary" onClick={() => useStore.setState({ settingsOpen: "downloads" })}>
                {t("voice.setUp")}
              </button>
            </>
          )}
        </Empty>
      </div>
    );
  }

  const live = phase !== "idle" && phase !== "ended" && phase !== "connecting";

  return (
    <div className="page voice">
      <TopBar title={t("voice.title")} right={<span className="pill pill-muted">{t("voice.onDevice", { device: deviceName() })}</span>} />
      <div className="voice-stage">
        {video && live && <video ref={preview} className="voice-preview" autoPlay muted playsInline aria-label={t("voice.yourCamera")} />}
        <div ref={orb} className={cx("orb", `phase-${phase}`, muted && "muted")}>
          <div className="orb-glow" />
          <div className="orb-core" />
        </div>
        <div className="voice-state">
          {phase === "connecting" && <Spinner size={14} />}
          {muted && live ? t("voice.muted") : t(PHASE_KEY[phase])}
        </div>
        {live && !cameraAvailable && <div className="muted small">{t("voice.cameraNeedsSlots")}</div>}
        {tool && (
          <div className="voice-tool">
            {tool.status === "running" || tool.status === "pending" ? <Spinner size={12} /> : <Wrench size={13} />}
            {tool.label}
          </div>
        )}
        <div className="captions">
          {you && <p className="caption you">{you}</p>}
          {agentText && <p className="caption agent">{agentText}</p>}
        </div>
        {error && <div className="voice-error">{error}</div>}
      </div>

      <div className="dock">
        <ApprovalDock chatId={sessionChat} />
        {typing && live && (
          <div className="voice-type">
            <input
              autoFocus
              value={typed}
              placeholder={t("voice.typeMessage")}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendTyped()}
            />
            <button className="round-btn primary" onClick={sendTyped} aria-label={t("common.send")}>
              <Send size={15} />
            </button>
          </div>
        )}
        <div className="voice-controls">
          {live ? (
            <>
              <button className={cx("voice-btn", muted && "on")} onClick={() => setMuted(!muted)} aria-label={muted ? t("voice.unmute") : t("voice.mute")}>
                {muted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
              <button
                className={cx("voice-btn", video && "on")}
                onClick={toggleVideo}
                disabled={!cameraAvailable}
                aria-label={video ? t("voice.cameraOff") : t("voice.cameraOn")}
                title={!cameraAvailable ? t("voice.cameraNeedsSlots") : video ? t("voice.cameraOff") : t("voice.cameraHint")}
              >
                {video ? <Video size={20} /> : <VideoOff size={20} />}
              </button>
              <button className={cx("voice-btn", typing && "on")} onClick={() => setTyping(!typing)} aria-label={t("voice.typeInstead")}>
                <Keyboard size={20} />
              </button>
              <button
                className="voice-btn end"
                onClick={() => {
                  end();
                  go(sessionChat && hasTranscript ? `#/chat/${sessionChat}` : "#/");
                }}
                aria-label={t("voice.endCall")}
              >
                <PhoneOff size={20} />
              </button>
            </>
          ) : (
            <>
              <button className="btn primary big" onClick={start} disabled={phase === "connecting"}>
                <Mic size={18} /> {phase === "ended" ? t("voice.startAgain") : t("voice.startTalking")}
              </button>
              {sessionChat && hasTranscript && phase === "ended" && (
                <button className="btn big" onClick={() => go(`#/chat/${sessionChat}`)}>
                  {t("voice.transcript")}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
