// Voice chat with LFM3 Omni 2B: it hears you, thinks and talks back in one
// model. Talk over it any time to interrupt.

import { useEffect, useRef, useState } from "react";
import { AudioLines, Keyboard, Mic, MicOff, PhoneOff, Send, Wrench } from "lucide-react";
import { socketURL } from "../api";
import { Mic as Microphone, SpeechDetector } from "../audio/capture";
import { Player } from "../audio/player";
import { stopSpeaking } from "../audio/speak";
import { go, part, useStore } from "../store";
import { DEVICE, cx } from "../util";
import { ApprovalDock } from "./ApprovalDock";
import { TopBar } from "./Shell";
import { Empty, Spinner } from "./ui";

type Phase = "idle" | "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "working" | "ended";

const PHASE_TEXT: Record<Phase, string> = {
  idle: "Ready when you are",
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Thinking",
  speaking: "Talk any time to interrupt",
  working: "Working on it",
  ended: "Call ended",
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
  const [sessionChat, setSessionChat] = useState<string | undefined>(chatId);
  const hasTranscript = useStore((s) => s.chats.some((c) => c.id === sessionChat && c.messages.length > 0));
  const orb = useRef<HTMLDivElement>(null);
  const session = useRef<{ ws: WebSocket; mic?: Microphone; player?: Player; level: number } | null>(null);
  const ready = omni?.status === "running";

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
    const s: { ws: WebSocket; mic?: Microphone; player?: Player; level: number } = { ws, level: 0 };
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
              for (const f of preroll) ws.send(f);
            },
            frame(pcm) {
              ws.send(pcm);
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
            setError("I can't use the microphone. Allow it in your browser's site settings, then try again.");
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
          setError(msg.message);
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
    session.current.ws.send(JSON.stringify({ type: "text", text }));
    setYou(text);
    setAgentText("");
    setTyped("");
  };

  if (!ready) {
    const waking = omni?.status === "starting";
    return (
      <div className="page">
        <TopBar title="Voice chat" />
        <Empty icon={waking ? <Spinner size={22} /> : <AudioLines size={22} />} title={waking ? "Getting voice ready…" : "Voice chat needs Eyes and ears"}>
          {waking ? (
            "This takes a few seconds."
          ) : (
            <>
              Voice chat listens and talks on your {DEVICE}. Nothing leaves it.
              <button className="btn primary" onClick={() => useStore.setState({ settingsOpen: "downloads" })}>
                Set it up
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
      <TopBar title="Voice chat" right={<span className="pill pill-muted">On this {DEVICE}</span>} />
      <div className="voice-stage">
        <div ref={orb} className={cx("orb", `phase-${phase}`, muted && "muted")}>
          <div className="orb-glow" />
          <div className="orb-core" />
        </div>
        <div className="voice-state">
          {phase === "connecting" && <Spinner size={14} />}
          {muted && live ? "You're muted" : PHASE_TEXT[phase]}
        </div>
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
              placeholder="Type a message"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendTyped()}
            />
            <button className="round-btn primary" onClick={sendTyped} aria-label="Send">
              <Send size={15} />
            </button>
          </div>
        )}
        <div className="voice-controls">
          {live ? (
            <>
              <button className={cx("voice-btn", muted && "on")} onClick={() => setMuted(!muted)} aria-label={muted ? "Unmute" : "Mute"}>
                {muted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
              <button className={cx("voice-btn", typing && "on")} onClick={() => setTyping(!typing)} aria-label="Type instead">
                <Keyboard size={20} />
              </button>
              <button
                className="voice-btn end"
                onClick={() => {
                  end();
                  go(sessionChat && hasTranscript ? `#/chat/${sessionChat}` : "#/");
                }}
                aria-label="End voice chat"
              >
                <PhoneOff size={20} />
              </button>
            </>
          ) : (
            <>
              <button className="btn primary big" onClick={start} disabled={phase === "connecting"}>
                <Mic size={18} /> {phase === "ended" ? "Start again" : "Start talking"}
              </button>
              {sessionChat && hasTranscript && phase === "ended" && (
                <button className="btn big" onClick={() => go(`#/chat/${sessionChat}`)}>
                  See transcript
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
