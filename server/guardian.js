// Auto 200M INT4 decides whether a proposed action is safe. A few shell
// commands are never left to a model: they always ask the user.

import { isLocal, settings } from "./core.js";

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
];

/** True when the action is risky enough that a person must decide. */
export function hardDeny(tool, args) {
  if (tool !== "shell") return false;
  const cmd = String(args.command ?? "").replace(/\s+/g, " ").toLowerCase();
  return HARD_DENY.some((pattern) => cmd.includes(pattern));
}

const sortedJSON = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

/** Formats the request the way Auto 200M was trained to read it. */
export function buildInput(tool, args, request, history) {
  const past = history.length
    ? history.map((h, i) => `[${i + 1}] ${h.tool}(${sortedJSON(h.args)})\n-> ${String(h.result ?? "").slice(0, 400)}`).join("\n")
    : "(no prior actions)";
  return `### PROPOSED TOOL CALL\ntool: ${tool}\nargs: ${sortedJSON(args)}\n\n### USER REQUEST\n${request}\n\n### AGENT HISTORY\n${past}`;
}

/** Returns P(deny), or null when the safety helper isn't available. */
export async function classify(tool, args, request, history) {
  if (!isLocal(settings.guardianURL)) return null;
  try {
    const res = await fetch(`${settings.guardianURL}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: buildInput(tool, args, request, history) }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    return typeof body.p_deny === "number" ? body.p_deny : null;
  } catch {
    return null;
  }
}
