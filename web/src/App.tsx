import { useEffect } from "react";
import { stopSpeaking } from "./audio/speak";
import { ApprovalDock } from "./components/ApprovalDock";
import { ChatView } from "./components/ChatView";
import { Activity, ForYou, Memory, Routines } from "./components/Pages";
import { SettingsModal, Setup } from "./components/Settings";
import { Toasts } from "./components/Shell";
import { Logo, Sidebar } from "./components/Sidebar";
import { Spinner } from "./components/ui";
import { VoiceView } from "./components/VoiceView";
import { connect, go, useStore } from "./store";

function useTheme() {
  const theme = useStore((s) => s.settings?.theme ?? "system");
  useEffect(() => {
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => (document.documentElement.dataset.theme = theme === "system" ? (dark.matches ? "dark" : "light") : theme);
    apply();
    dark.addEventListener("change", apply);
    return () => dark.removeEventListener("change", apply);
  }, [theme]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        go("#/");
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useStore.setState({ settingsOpen: "general" });
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search input")?.focus();
      } else if (e.key === "Escape" && useStore.getState().speaking) stopSpeaking();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const { loaded, connected, parts, route, chats } = useStore();
  useTheme();
  useShortcuts();
  useEffect(connect, []);

  const chat = route.page === "chat" && route.chatId ? chats.find((c) => c.id === route.chatId) : undefined;
  useEffect(() => {
    document.title = chat ? `${chat.title} · Liquid Agent` : "Liquid Agent";
  }, [chat?.title]);

  if (!loaded) {
    return (
      <div className="splash">
        <Logo size={44} />
        <div className="splash-text">
          <Spinner size={14} /> {connected ? "Loading…" : "Connecting to Liquid Agent…"}
        </div>
        <Toasts />
      </div>
    );
  }

  const hasModel = parts.some((p) => (p.id === "small" || p.id === "omni") && ["installed", "starting", "running"].includes(p.status));
  if (!hasModel) {
    return (
      <>
        <Setup />
        <Toasts />
      </>
    );
  }

  let page;
  switch (route.page) {
    case "voice":
      page = <VoiceView chatId={route.chatId} />;
      break;
    case "foryou":
      page = <ForYou />;
      break;
    case "routines":
      page = <Routines />;
      break;
    case "memory":
      page = <Memory />;
      break;
    case "activity":
      page = <Activity />;
      break;
    default:
      page = <ChatView key={route.chatId ?? "new"} chatId={route.chatId} />;
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {page}
        {route.page !== "chat" && route.page !== "voice" && (
          <div className="floating-approval">
            <ApprovalDock showChat />
          </div>
        )}
      </main>
      <SettingsModal />
      <Toasts />
    </div>
  );
}
