// Packs the built app into one ready-to-run bundle, so installing and updating
// need no npm or build step. Run after `npm run build`:
//
//   node scripts/bundle.mjs [--build N] [--url URL] [--out DIR]
//
// Writes DIR/liquid-agent.tar.gz (one liquid-agent/ folder holding the server,
// the built web UI and its runtime packages) and DIR/latest.json, which
// installed copies read to find new builds. The build number defaults to the
// number of commits, so every push to main gets a bigger one.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const repo = process.env.GITHUB_REPOSITORY ?? "morriszdweck/liquid-agent";
const build = Number(arg("build", process.env.LIQUID_AGENT_BUILD ?? git("rev-list", "--count", "HEAD")));
const commit = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
const url = arg("url", `https://github.com/${repo}/releases/download/build-${build}/liquid-agent.tar.gz`);
const out = path.resolve(arg("out", path.join(ROOT, "release")));
if (!Number.isInteger(build) || build < 1) throw new Error("The build number must be a whole number above 0.");
if (!fs.existsSync(path.join(ROOT, "web", "dist", "index.html"))) throw new Error("Run npm run build first.");

const stage = fs.mkdtempSync(path.join(out + "-"));
const app = path.join(stage, "liquid-agent");
const skip = new Set(["node_modules", ".venv", "__pycache__", ".DS_Store"]);
const copy = (from, to = from) =>
  fs.cpSync(path.join(ROOT, from), path.join(app, to), { recursive: true, filter: (src) => !skip.has(path.basename(src)) });

try {
  for (const part of ["server", "guardian", "bridge", "web/dist", "LICENSE", "README.md"]) copy(part);

  // Runtime packages, with whatever they depend on in turn.
  const wanted = [...Object.keys(pkg.dependencies ?? {})];
  for (const name of wanted) {
    const dir = path.join("node_modules", name);
    if (fs.existsSync(path.join(app, dir))) continue;
    fs.cpSync(path.join(ROOT, dir), path.join(app, dir), { recursive: true });
    wanted.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8")).dependencies ?? {}));
  }

  const { devDependencies, scripts, ...runtime } = pkg;
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ ...runtime, scripts: { start: scripts.start } }, null, 2) + "\n");
  fs.writeFileSync(path.join(app, "build.json"), JSON.stringify({ build, commit, repo, date: new Date().toISOString() }, null, 2) + "\n");

  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, "liquid-agent.tar.gz");
  // No macOS extended attributes, so Linux tar unpacks it without warnings.
  execFileSync("tar", ["-czf", file, ...(process.platform === "darwin" ? ["--no-xattrs"] : []), "-C", stage, "liquid-agent"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const data = fs.readFileSync(file);
  const latest = { build, version: pkg.version, commit, url, size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
  fs.writeFileSync(path.join(out, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
  console.log(`Build ${build}: ${file.startsWith(ROOT) ? path.relative(ROOT, file) : file} (${(data.length / 1e6).toFixed(1)} MB)`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
