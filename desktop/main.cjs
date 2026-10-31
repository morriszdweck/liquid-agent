// Liquid Agent for macOS: a window onto the Liquid Agent that runs on this
// computer. It starts that copy (installing it the first time, with the same
// installer as the one-line command) and shows it. The agent updates itself,
// so this shell rarely needs a new version.

const { app, BrowserWindow, Menu, desktopCapturer, nativeTheme, session, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.env.LIQUID_AGENT_PORT || 8170);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(os.homedir(), ".liquid-agent");
const SERVER = path.join(ROOT, "app", "server", "index.js");
const DATA = path.join(os.homedir(), "Library", "Application Support", "LiquidAgent");
const INSTALLER = "https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh";

let win = null;
let startedServer = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocal = (url) => {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
};

async function running() {
  try {
    const res = await fetch(`${ORIGIN}/healthz`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).app === "liquid-agent";
  } catch {
    return false;
  }
}

/** The Node.js the installer picked: it is written into the liquid-agent command. */
function installedNode() {
  try {
    const script = fs.readFileSync(path.join(ROOT, "bin", "liquid-agent"), "utf8");
    const node = script.match(/nohup "([^"]+)" "\$ROOT\/app\/server\/index\.js"/)?.[1];
    if (node && fs.existsSync(node)) return node;
  } catch {}
  return [path.join(ROOT, "node", "bin", "node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"].find((p) => fs.existsSync(p)) ?? null;
}

function startServer() {
  const node = installedNode();
  if (!node) throw new Error("Couldn't find Node.js for Liquid Agent. Reinstall it from liquid-agent.mincoffical.codes.");
  fs.mkdirSync(path.join(DATA, "logs"), { recursive: true });
  const log = fs.openSync(path.join(DATA, "logs", "server.log"), "a");
  // Detached, like the liquid-agent command, so it keeps running reminders and routines on its own schedule.
  spawn(node, [SERVER], { detached: true, stdio: ["ignore", log, log], env: { ...process.env, LIQUID_AGENT_PORT: String(PORT) } }).unref();
  startedServer = true;
}

async function waitUntilRunning(seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await running()) return true;
    await sleep(500);
  }
  return false;
}

/** Runs the one-line installer, showing what it prints on the setup screen. */
function install(say) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", `curl -fsSL ${INSTALLER} | bash`], {
      env: { ...process.env, LIQUID_AGENT_NO_OPEN: "1", LIQUID_AGENT_DESKTOP: "1", LIQUID_AGENT_PORT: String(PORT) },
    });
    let tail = "";
    const read = (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000);
      for (const line of chunk.toString().split("\n")) {
        const text = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^→\s*/, "").trim();
        if (text) say(text);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(tail.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop() || "The installer stopped."))));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "Liquid Agent",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 27 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0b" : "#f3f3f4",
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => (win = null));
  // Links out of the app open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isLocal(url) || url.startsWith("data:")) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  return win;
}

async function open() {
  const w = win ?? createWindow();
  const say = (text) => w.webContents.executeJavaScript(`window.say && window.say(${JSON.stringify(text)})`).catch(() => {});
  if (await running()) return w.loadURL(ORIGIN);
  await w.loadFile(path.join(__dirname, "setup.html"));
  try {
    if (!fs.existsSync(SERVER)) {
      say("Setting up Liquid Agent. This takes a minute the first time.");
      await install(say);
    }
    if (!(await running())) {
      say("Starting Liquid Agent…");
      startServer();
    }
    if (!(await waitUntilRunning(60))) throw new Error(`Liquid Agent didn't start. Its log is in ${path.join(DATA, "logs", "server.log")}.`);
    await w.loadURL(ORIGIN);
  } catch (e) {
    w.webContents.executeJavaScript(`window.failed && window.failed(${JSON.stringify(String(e?.message ?? e))})`).catch(() => {});
  }
}

if (!app.requestSingleInstanceLock()) app.quit();

app.on("second-instance", () => {
  if (!win) return open();
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { label: "View", submenu: [{ role: "reload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
      { role: "windowMenu" },
      { role: "help", submenu: [{ label: "Liquid Agent Website", click: () => shell.openExternal("https://liquid-agent.mincoffical.codes") }] },
    ]),
  );
  // Microphone, camera, screen and notifications, for Liquid Agent's own page only.
  const allowed = new Set(["media", "display-capture", "notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed.has(permission) && isLocal(details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && isLocal(origin));
  // "Look at my screen": share the whole main screen.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );
  open();
});

app.on("activate", () => {
  if (!win) open();
});

// Closing the window keeps the app in the Dock, like other Mac apps.
app.on("window-all-closed", () => {});

// Quitting stops the copy this app started; one started from the command line keeps running.
app.on("will-quit", () => {
  if (startedServer) execFile("/usr/bin/pkill", ["-f", SERVER]);
});
