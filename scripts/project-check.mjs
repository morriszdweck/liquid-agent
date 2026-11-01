// Checks that a chat tied to a project folder stays inside it: file tools
// refuse outside paths and shell commands can't write or read outside it.
// Needs no models. Uses a temporary home folder.
//
//   node scripts/project-check.mjs [--need-sandbox]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "liquid-agent-project-"));
process.env.LIQUID_AGENT_HOME = data;
const HOME = os.homedir();
// The project and a "private" folder both live in the real home folder, like they would for a user.
const root = fs.mkdtempSync(path.join(HOME, "la-project-check-"));
const secret = fs.mkdtempSync(path.join(HOME, "la-private-check-"));
fs.writeFileSync(path.join(secret, "secret.txt"), "top secret");
fs.writeFileSync(path.join(root, "hello.txt"), "hello from the project");
fs.symlinkSync(secret, path.join(root, "sneaky"));

const P = await import("../server/project.js");
const { runTool } = await import("../server/tools.js");

let failed = false;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};
const ctx = { project: P.projectFolder(root), signal: undefined };
const tool = (name, args) => runTool(name, args, ctx);

try {
  const kind = P.sandboxKind();
  console.log(`sandbox: ${kind ?? "none (path check only)"}`);
  if (process.argv.includes("--need-sandbox")) check(Boolean(kind), "a shell sandbox is available");

  check((await tool("read_file", { path: "hello.txt" })).text === "hello from the project", "reads a file in the project");
  check((await tool("write_file", { path: "sub/new.txt", content: "hi" })).ok && fs.existsSync(path.join(root, "sub/new.txt")), "writes a file in the project");
  check(/hello\.txt/.test((await tool("list_dir", {})).text), "lists the project");
  for (const p of [path.join(secret, "secret.txt"), "../" + path.basename(secret) + "/secret.txt", "sneaky/secret.txt", "~/" + path.basename(secret)]) {
    const r = await tool(p.endsWith("secret.txt") ? "read_file" : "list_dir", { path: p });
    check(!r.ok && /outside the project/.test(r.text), `refuses ${p}`);
  }
  const w = await tool("write_file", { path: path.join(secret, "planted.txt"), content: "x" });
  check(!w.ok && !fs.existsSync(path.join(secret, "planted.txt")), "refuses writing outside");

  const inside = await tool("shell", { command: "echo ok > made.txt && cat made.txt && pwd" });
  check(inside.ok && inside.text.includes("ok") && fs.existsSync(path.join(root, "made.txt")), "shell works in the project", JSON.stringify(inside.text.slice(-80)));
  const out = await tool("shell", { command: `echo x > ${path.join(secret, "shell.txt")}` });
  check(!fs.existsSync(path.join(secret, "shell.txt")), "shell can't write outside", JSON.stringify(out.text.slice(-120)));
  const read = await tool("shell", { command: `cat ${path.join(secret, "secret.txt")}` });
  check(!read.text.includes("top secret"), "shell can't read the rest of home", JSON.stringify(read.text.slice(-120)));
  const link = await tool("shell", { command: "cat sneaky/secret.txt" });
  check(!link.text.includes("top secret"), "shell can't follow a symlink out", JSON.stringify(link.text.slice(-120)));
  check(!P.inside(ctx.project, path.join(root, "..")), "the parent folder is outside");
  let refused = false;
  try {
    P.projectFolder(HOME);
  } catch {
    refused = true;
  }
  check(refused, "the whole home folder can't be a project");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(secret, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
