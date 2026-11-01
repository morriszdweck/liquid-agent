// The first-run screen the Mac app shows while Liquid Agent is set up. The app
// calls window.say(text) for progress and window.failed(text) when setup stops.
// Messages that start with "@" are keys the app sends in its own words; they are
// shown in the language of this computer. Anything else is the installer's own
// output and is shown as it comes.

declare global {
  interface Window {
    say: (text: string) => void;
    failed: (text: string) => void;
  }
}

const messages = {
  en: { settingUp: "Setting up Liquid Agent. This takes a minute the first time.", starting: "Starting Liquid Agent…", notStarted: "Liquid Agent didn't start. Its log is in {path}." },
  es: { settingUp: "Configurando Liquid Agent. Tarda un minuto la primera vez.", starting: "Iniciando Liquid Agent…", notStarted: "Liquid Agent no se inició. Su registro está en {path}." },
  pt: { settingUp: "Configurando o Liquid Agent. Leva um minuto na primeira vez.", starting: "Iniciando o Liquid Agent…", notStarted: "O Liquid Agent não iniciou. O registro está em {path}." },
  fr: { settingUp: "Installation de Liquid Agent. Cela prend une minute la première fois.", starting: "Démarrage de Liquid Agent…", notStarted: "Liquid Agent n'a pas démarré. Son journal se trouve dans {path}." },
  de: { settingUp: "Liquid Agent wird eingerichtet. Das dauert beim ersten Mal eine Minute.", starting: "Liquid Agent wird gestartet…", notStarted: "Liquid Agent konnte nicht starten. Das Protokoll liegt in {path}." },
  it: { settingUp: "Configurazione di Liquid Agent. La prima volta richiede un minuto.", starting: "Avvio di Liquid Agent…", notStarted: "Liquid Agent non si è avviato. Il registro è in {path}." },
  zh: { settingUp: "正在设置 Liquid Agent。首次需要一分钟。", starting: "正在启动 Liquid Agent…", notStarted: "Liquid Agent 未能启动。日志位于 {path}。" },
  ja: { settingUp: "Liquid Agent をセットアップしています。初回は1分ほどかかります。", starting: "Liquid Agent を起動しています…", notStarted: "Liquid Agent を起動できませんでした。ログは {path} にあります。" },
} as const;

type Key = keyof (typeof messages)["en"];

/** The language of this computer, as the page sees it, or English for anything not in the list. */
function table() {
  const code = (navigator.language || "en").toLowerCase().split("-")[0] as keyof typeof messages;
  return messages[code] ?? messages.en;
}

/** Turns "@key" or "@key:detail" from the app into the words for this computer. */
function translate(text: string): string {
  if (!text.startsWith("@")) return text;
  const [key, ...rest] = text.slice(1).split(":");
  const words = table()[key as Key] ?? messages.en[key as Key] ?? text;
  return words.replace("{path}", rest.join(":"));
}

const status = document.getElementById("status");
if (status) status.textContent = table().starting;

window.say = (text: string) => {
  if (status) status.textContent = translate(text);
};

window.failed = (text: string) => {
  document.body.classList.add("done");
  status?.classList.add("bad");
  if (status) status.textContent = translate(text);
};

export {};
