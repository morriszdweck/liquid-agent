// scripts/dev.mjs
// Runs the Vite UI builder and Node backend server concurrently in development.
// Cross-platform: works seamlessly on Windows (cmd.exe, PowerShell) and macOS/Linux.

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

// Helper to kill a process and its child tree cleanly
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (IS_WIN && child.pid) {
    try {
      execSync(`taskkill.exe /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

// 1. Start Vite UI watcher (rebuilds web/dist on web/ changes without clearing terminal)
const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const ui = fs.existsSync(viteBin)
  ? spawn(process.execPath, [viteBin, "build", "--watch", "--mode", "development", "--clearScreen=false"], {
      cwd: ROOT,
      stdio: "inherit",
    })
  : spawn(IS_WIN ? "npm.cmd" : "npm", ["run", "dev:ui"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: IS_WIN,
    });

// 2. Start Node server watcher (restarts server on server/ changes)
const serverScript = path.join(ROOT, "server", "index.js");
const server = spawn(process.execPath, ["--watch-path=server", serverScript, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
});

let stopping = false;
function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  killTree(ui);
  killTree(server);
  process.exit(exitCode);
}

// Listen for termination signals
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => {
  if (!stopping) {
    stopping = true;
    killTree(ui);
    killTree(server);
  }
});

ui.on("exit", (code) => {
  if (!stopping) {
    if (code !== 0 && code !== null) {
      console.error(`\n[dev] UI builder exited unexpectedly with code ${code}.`);
      shutdown(code);
    } else {
      shutdown(0);
    }
  }
});

server.on("exit", (code) => {
  if (!stopping) {
    if (code !== 0 && code !== null) {
      console.error(`\n[dev] Server exited unexpectedly with code ${code}.`);
      shutdown(code);
    } else {
      shutdown(0);
    }
  }
});
