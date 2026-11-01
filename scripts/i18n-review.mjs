// Prints every translated string in the app as CSV, for a native speaker to check.
//
//   node scripts/i18n-review.mjs > i18n-review.csv
//
// Columns: source, language, key, text, correction. The reviewer fills in "correction"
// where the text is wrong, and leaves it empty where it is right.
// Sources: "web" (web/src/i18n/locales), "rust" (the prompt and reply tables in
// crates/liquid-core/src/i18n.rs), "rust-console" and "rust-diag" (the terminal and log lines
// in the same file).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const CODES = ["en", "es", "pt", "fr", "de", "it", "zh", "ja"];
const rows = [];

// Lines in the locale files look like:  "key": "text",
for (const code of CODES) {
  const file = path.join(repo, "web/src/i18n/locales", `${code}.ts`);
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/);
    if (m) rows.push(["web", code, m[1], unescape(m[2])]);
  }
}

// Tables in the Rust file look like:  static ES: Strings = Strings {  ...  };
// Simple fields are  name: "text",  and the lists are  name: &[ ("a", "b"), ... ]  .
const rust = fs.readFileSync(path.join(repo, "crates/liquid-core/src/i18n.rs"), "utf8").split("\n");
let block = null;
let list = null;
let pendingField = null;
for (const line of rust) {
  const start = line.match(/^(?:static|const) (\w+): \w+ = \w+ \{$/);
  if (start) {
    block = start[1];
    list = null;
    continue;
  }
  if (block && /^\};$/.test(line)) {
    block = null;
    continue;
  }
  if (!block) continue;
  const source = block.startsWith("CONSOLE_") ? "rust-console" : block.startsWith("DIAG_") ? "rust-diag" : "rust";
  const code = block.split("_").pop().toLowerCase();
  const listStart = line.match(/^\s+(\w+): &\[\s*$/);
  if (listStart) {
    list = listStart[1];
    continue;
  }
  if (list && /^\s+\],?\s*$/.test(line)) {
    list = null;
    continue;
  }
  const pair = line.match(/^\s+\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\),?\s*$/);
  if (pair && list) {
    rows.push([source, code, `${list}:${unescape(pair[1])}`, unescape(pair[2])]);
    continue;
  }
  // rustfmt moves a long value to the line below its name.
  const name = line.match(/^\s+(\w+):\s*$/);
  if (name) {
    pendingField = name[1];
    continue;
  }
  const field = line.match(/^\s+(\w+): "((?:[^"\\]|\\.)*)",?\s*$/);
  if (field) rows.push([source, code, field[1], unescape(field[2])]);
  const wrapped = line.match(/^\s+"((?:[^"\\]|\\.)*)",?\s*$/);
  if (wrapped && pendingField) {
    rows.push([source, code, pendingField, unescape(wrapped[1])]);
    pendingField = null;
  }
}

function unescape(text) {
  return text.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
}

const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
const lines = [["source", "language", "key", "text", "correction"].map(quote).join(",")];
for (const row of rows) lines.push([...row, ""].map(quote).join(","));
process.stdout.write(lines.join("\n") + "\n");
console.error(`${rows.length} strings in ${new Set(rows.map((r) => r[1])).size} languages`);
