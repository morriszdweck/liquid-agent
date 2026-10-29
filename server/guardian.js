// Auto 200M INT4 decides whether a proposed action is safe. A few shell
// commands are never left to a model: they always ask the user.

import { IS_MAC, isLocal, settings } from "./core.js";
import { copyCommand } from "./platform.js";

const HARD_DENY = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf *",
  "sudo ",
  "mkfs",
  "dd if=",
  ":(){",
  "chmod -R 777",
  "curl | sh",
  "| sh",
  "| bash",
  "| zsh",
  "diskutil erase",
  "launchctl",
  "security ",
  "csrutil",
  "defaults delete",
  "osascript",
  "> /dev/",
  "shutdown",
  "reboot",
  // Linux
  "pkexec",
  "doas ",
  "su -",
  "su root",
  "systemctl stop",
  "systemctl disable",
  "systemctl mask",
  "systemctl isolate",
  "wipefs",
  "fdisk",
  "parted ",
  "mkswap",
  "poweroff",
  "crontab -r",
  "chattr ",
];

/** True when the action is risky enough that a person must decide. */
export function hardDeny(tool, args) {
  if (tool !== "shell") return false;
  const cmd = String(args.command ?? "").replace(/\s+/g, " ").toLowerCase();
  return HARD_DENY.some((pattern) => cmd.includes(pattern));
}

/**
 * Auto 200M was trained on coding-agent tools (Bash, Read, Write, WebFetch…)
 * with plain-string arguments, so actions are described to it in those terms.
 */
export function forAuto(tool, args = {}) {
  const compact = (value) => JSON.stringify(value);
  switch (tool) {
    case "shell":
      return { tool: "Bash", args: String(args.command ?? "") };
    case "read_file":
      return { tool: "Read", args: String(args.path ?? "") };
    case "write_file":
      return { tool: "Write", args: compact({ file_path: args.path, content: String(args.content ?? "").slice(0, 4000) }) };
    case "list_dir":
      return { tool: "LS", args: String(args.path ?? ".") };
    case "web_search":
      return { tool: "WebSearch", args: String(args.query ?? "") };
    case "fetch_url":
      return { tool: "WebFetch", args: String(args.url ?? "") };
    case "open":
      return { tool: "Bash", args: `${IS_MAC ? "open" : "xdg-open"} ${JSON.stringify(String(args.target ?? ""))}` };
    case "set_clipboard":
      return { tool: "Bash", args: `${copyCommand()} <<< ${JSON.stringify(String(args.text ?? ""))}` };
    default:
      return { tool, args: compact(args) };
  }
}

/** Returns P(deny), or null when the safety helper isn't available. */
export async function classify(tool, args, request, history) {
  if (!isLocal(settings.guardianURL)) return null;
  try {
    const res = await fetch(`${settings.guardianURL}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...forAuto(tool, args),
        request: String(request ?? ""),
        history: history.map((h) => ({ ...forAuto(h.tool, h.args), result: String(h.result ?? "").slice(0, 400) })),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    return typeof body.p_deny === "number" ? body.p_deny : null;
  } catch {
    return null;
  }
}
