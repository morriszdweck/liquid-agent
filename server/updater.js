// Keeps an installed copy up to date by itself, with no npm or build step.
//
// Every push to main publishes a ready-to-run bundle as a GitHub release
// (scripts/bundle.mjs). An installed copy carries build.json; a source checkout
// has none and updates with git instead. A newer build downloads into
// app.next beside the app and goes in once nothing is running: this server
// hands over to a small shell script that swaps the folders, starts the new
// copy and puts the old one back if the new one doesn't come up.

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DIRS, ROOT, bus, load, run, save, settings } from "./core.js";
import { agent } from "./agent.js";
import { backends } from "./backends.js";
import { voiceCalls } from "./voice.js";

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const VERSION = read(path.join(ROOT, "package.json"))?.version ?? "";
/** { build, commit, repo } for a release bundle; null in a source checkout. */
export const BUILD = read(path.join(ROOT, "build.json"));
const NEXT = `${ROOT}.next`;
const DOWNLOAD = `${ROOT}.download`;
const FEED = process.env.LIQUID_AGENT_UPDATE_URL ?? (BUILD?.repo ? `https://github.com/${BUILD.repo}/releases/latest/download/latest.json` : "");
const CHECK_EVERY = 6 * 3600_000;
const IDLE_POLL = 30_000;

/** Can this copy replace itself? Only a release bundle in a folder we may write to. */
const managed = (() => {
  if (!BUILD?.build || !FEED) return false;
  try {
    fs.accessSync(path.dirname(ROOT), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();

const idle = () => agent.running.length === 0 && voiceCalls.size === 0 && !backends.busy;

class Updater {
  /** idle | checking | downloading | ready | updating | error */
  state = "idle";
  /** The build waiting in app.next. */
  ready = null;
  progress = 0;
  error = "";
  checkedAt = 0;
  quietPolls = 0;
  shutdown = () => process.exit(0);

  get snapshot() {
    return {
      version: VERSION,
      build: BUILD?.build ?? null,
      managed,
      state: this.state,
      ready: this.ready,
      progress: this.progress,
      error: this.error,
      checkedAt: this.checkedAt,
    };
  }

  emit() {
    bus.emit("update", { update: this.snapshot });
  }

  /** Starts the background checks. `shutdown` stops this server cleanly. */
  start(shutdown) {
    this.shutdown = shutdown;
    if (!managed) return;
    fs.rmSync(DOWNLOAD, { recursive: true, force: true });
    fs.rmSync(`${ROOT}.old`, { recursive: true, force: true });
    // A build that started and failed was put back; don't try it again.
    const bad = read(path.join(`${ROOT}.bad`, "build.json"))?.build;
    if (bad) {
      save("update.json", { ...load("update.json", {}), skip: bad });
      fs.rmSync(`${ROOT}.bad`, { recursive: true, force: true });
    }
    // A download from before a restart that never went in.
    const waiting = read(path.join(NEXT, "build.json"))?.build;
    if (waiting > BUILD.build && waiting !== this.skip) {
      this.ready = waiting;
      this.state = "ready";
    } else {
      fs.rmSync(NEXT, { recursive: true, force: true });
    }
    setTimeout(() => settings.autoUpdate && this.check().catch(() => {}), 60_000).unref();
    setInterval(() => settings.autoUpdate && this.check().catch(() => {}), CHECK_EVERY).unref();
    setInterval(() => this.whenIdle(), IDLE_POLL).unref();
  }

  get skip() {
    return load("update.json", {}).skip ?? 0;
  }

  /** Looks for a newer build and downloads it. */
  async check() {
    if (!managed || ["checking", "downloading", "updating"].includes(this.state)) return this.snapshot;
    this.state = "checking";
    this.error = "";
    this.emit();
    try {
      const res = await fetch(FEED, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Couldn't check for updates (${res.status}).`);
      const feed = await res.json();
      this.checkedAt = Date.now();
      const build = Number(feed.build);
      if (!(build > BUILD.build) || build === this.skip) {
        this.state = this.ready ? "ready" : "idle";
      } else if (this.ready !== build) {
        await this.download(feed);
        this.ready = build;
        this.state = "ready";
      } else {
        this.state = "ready";
      }
    } catch (e) {
      this.state = this.ready ? "ready" : "error";
      this.error = e.name === "TimeoutError" ? "Couldn't reach GitHub to check for updates." : String(e.message ?? e).slice(0, 200);
    }
    this.emit();
    return this.snapshot;
  }

  async download(feed) {
    this.state = "downloading";
    this.progress = 0;
    this.emit();
    fs.rmSync(DOWNLOAD, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOAD, { recursive: true });
    try {
      const file = path.join(DOWNLOAD, "liquid-agent.tar.gz");
      const res = await fetch(new URL(feed.url, FEED), { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`The update download failed (${res.status}).`);
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(file);
      let got = 0;
      let shown = 0;
      for await (const chunk of res.body) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        const pct = feed.size ? Math.floor((got / feed.size) * 100) : 0;
        if (pct >= shown + 5) {
          this.progress = shown = pct;
          this.emit();
        }
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (hash.digest("hex") !== feed.sha256) throw new Error("The update didn't match its checksum, so it was thrown away.");
      await run("tar", ["-xzf", file, "-C", DOWNLOAD], { timeout: 120_000 });
      const unpacked = path.join(DOWNLOAD, "liquid-agent");
      if (read(path.join(unpacked, "build.json"))?.build !== Number(feed.build) || !fs.existsSync(path.join(unpacked, "server", "index.js")))
        throw new Error("The update doesn't look like Liquid Agent, so it was thrown away.");
      fs.rmSync(NEXT, { recursive: true, force: true });
      fs.renameSync(unpacked, NEXT);
      this.progress = 100;
    } finally {
      fs.rmSync(DOWNLOAD, { recursive: true, force: true });
    }
  }

  /** Puts a downloaded build in once nothing has been running for a little while. */
  whenIdle() {
    if (this.state !== "ready" || !settings.autoUpdate) return;
    this.quietPolls = idle() ? this.quietPolls + 1 : 0;
    if (this.quietPolls >= 2) this.apply();
  }

  /** Hands over to the new build now. */
  apply() {
    if (this.state !== "ready" || !fs.existsSync(NEXT)) return this.snapshot;
    this.state = "updating";
    this.emit();
    console.log(`Updating to build ${this.ready}`);
    const port = process.env.LIQUID_AGENT_PORT ?? "8170";
    const args = process.argv.slice(2).filter((a) => a !== "--open");
    const log = fs.openSync(path.join(DIRS.logs, "server.log"), "a");
    const child = spawn("/bin/sh", ["-c", HANDOVER, "handover", String(process.pid), ROOT, process.execPath, port, String(this.ready), ...args], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    let failed = false;
    child.on("error", (e) => {
      // Nothing will start the new copy, so stay up on this one.
      failed = true;
      this.state = "error";
      this.error = `Couldn't restart to update: ${e.message}`;
      this.emit();
    });
    child.unref();
    fs.closeSync(log);
    setTimeout(() => !failed && this.shutdown(), 500);
    return this.snapshot;
  }
}

// Runs after this server exits: swap app.next in, start it, and put the old
// copy back (as app.bad, so it isn't tried again) if the new one doesn't answer.
const HANDOVER = `
pid=$1 app=$2 node=$3 port=$4 build=$5
shift 5
start() { "$node" "$app/server/index.js" "$@" </dev/null & child=$!; }
i=0
while kill -0 "$pid" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i + 1)); done
rm -rf "$app.old"
if ! mv "$app" "$app.old"; then start "$@"; exit 1; fi
if ! mv "$app.next" "$app"; then mv "$app.old" "$app"; start "$@"; exit 1; fi
start "$@"
i=0
while [ $i -lt 120 ]; do
  if curl -fs --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null | grep -q "\\"build\\":$build[,}]"; then
    rm -rf "$app.old"
    echo "Updated to build $build"
    exit 0
  fi
  kill -0 "$child" 2>/dev/null || break
  sleep 0.5
  i=$((i + 1))
done
echo "Build $build didn't start, so the old version is back."
kill "$child" 2>/dev/null
sleep 1
rm -rf "$app.bad"
mv "$app" "$app.bad" && mv "$app.old" "$app"
start "$@"
`;

export const updater = new Updater();
