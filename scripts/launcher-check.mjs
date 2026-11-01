// Exercise the installer and native launcher in a disposable home directory.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "liquid launcher "));
const socket = net.createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, "data"), LIQUID_AGENT_PORT: String(port), LIQUID_AGENT_BUNDLE: path.join(repo, "release/liquid-agent.tar.gz"), LIQUID_AGENT_NO_OPEN: "1" };
delete env.LIQUID_AGENT_HOME;
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
const launcher = path.join(home, ".local/bin/liquid-agent");
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { env, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
};
const health = async () => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).app === "liquid-agent"; }
  catch { return false; }
};
const wait = async (wanted) => {
  for (let i = 0; i < 100; i++) {
    if (await health() === wanted) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not ${wanted ? "start" : "stop"}`);
};
try {
  run("bash", [path.join(repo, "install.sh")]);
  run(launcher, ["open"]);
  await wait(true);
  run(launcher, ["logs"]);
  run(launcher, ["stop"]);
  await wait(false);
  console.log("✓ installed Rust launcher starts and stops the app");
} finally {
  if (fs.existsSync(launcher)) spawnSync(launcher, ["stop"], { env, stdio: "ignore", timeout: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
