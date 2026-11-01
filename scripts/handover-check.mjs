// Exercise successful updates and rollback using isolated fake app folders.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-handover-"));
// The launcher that performs the swap (built with: cargo build -p liquid-guardian).
const repo = new URL("..", import.meta.url).pathname;
const handoverProgram = process.env.LIQUID_AGENT_GUARDIAN ?? path.join(repo, "target", "debug", "liquid-guardian");
const SERVER_NAME = "liquid-server-test";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
let live;
let serverPid;
try {
  for (const failure of [false, true]) {
    const parent = path.join(root, failure ? "rollback" : "success");
    const app = path.join(parent, "app");
    const next = `${app}.next`;
    for (const dir of [app, next]) fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(app, "marker"), "old");
    fs.writeFileSync(path.join(next, "marker"), "new");
    const pidFile = path.join(parent, "server.pid");
    const server = (build) => `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('http').createServer((q,s)=>s.end(JSON.stringify({app:'liquid-agent',build:${build}}))).listen(${port},'127.0.0.1')`;
    const script = (file, code) => {
      fs.writeFileSync(file, `#!${process.execPath}\n${code}\n`);
      fs.chmodSync(file, 0o755);
    };
    script(path.join(app, "bin", SERVER_NAME), server(1));
    script(path.join(next, "bin", SERVER_NAME), failure ? "process.exit(1)" : server(2));
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    // This child has exited and been reaped, so it is safe for the handover to proceed.
    const hand = spawn(handoverProgram, ["--handover", String(exited.pid), app, SERVER_NAME, String(port), "2"], { stdio: "ignore" });
    const handExit = once(hand, "exit");
    for (let i = 0; i < 100; i++) {
      try {
        const state = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
        if (fs.existsSync(pidFile) && state.build === (failure ? 1 : 2) && fs.readFileSync(path.join(app, "marker"), "utf8") === (failure ? "old" : "new")) break;
      } catch {}
      await sleep(100);
      if (i === 99) throw new Error("handover did not start expected server");
    }
    const marker = fs.readFileSync(path.join(app, "marker"), "utf8");
    if (marker !== (failure ? "old" : "new")) throw new Error("wrong app after handover");
    const [code] = await handExit;
    if (code !== 0) throw new Error(`handover exited with ${code}`);
    live = hand;
    serverPid = Number(fs.readFileSync(pidFile, "utf8"));
    process.kill(serverPid, "SIGTERM");
    for (let i = 0; i < 30; i++) { try { await fetch(`http://127.0.0.1:${port}`); } catch { break; } await sleep(100); }
    serverPid = undefined;
    console.log(failure ? "✓ failed update rolls back" : "✓ update starts the new build");
  }
} finally {
  live?.kill();
  if (serverPid) { try { process.kill(serverPid, "SIGTERM"); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
}
