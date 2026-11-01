// Packs the built app into one ready-to-run bundle, so installing and updating
// need no npm or build step. Run after `npm run build`:
//
//   node scripts/bundle.mjs [--build N] [--url URL] [--out DIR] [--binaries DIR]
//
// Writes DIR/liquid-agent.tar.gz (one liquid-agent/ folder holding the Rust
// server and launcher for each platform, and the built web UI) and DIR/latest.json,
// which installed copies read to find new builds. The build number defaults to the
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
const binaries = arg("binaries", "");
if (!Number.isInteger(build) || build < 1) throw new Error("The build number must be a whole number above 0.");
if (!fs.existsSync(path.join(ROOT, "web", "dist", "index.html"))) throw new Error("Run npm run build first.");

const stage = fs.mkdtempSync(path.join(out + "-"));
const app = path.join(stage, "liquid-agent");
const skip = new Set(["node_modules", ".venv", "__pycache__", ".DS_Store"]);
const copy = (from, to = from) =>
  fs.cpSync(path.join(ROOT, from), path.join(app, to), { recursive: true, filter: (src) => !skip.has(path.basename(src)) });

try {
  for (const part of ["web/dist", "LICENSE", "README.md"]) copy(part);
  fs.mkdirSync(path.join(app, "bin"), { recursive: true });
  // bin/liquid-server-<platform> is the server; bin/liquid-guardian-<platform> is the launcher and safety helper.
  const platform = `${process.platform}-${process.arch}`;
  if (binaries) {
    fs.cpSync(path.resolve(binaries), path.join(app, "bin"), { recursive: true });
  } else {
    // A local build: the same profile for both programs.
    for (const name of ["liquid-guardian", "liquid-server"]) {
      const local = ["release", "debug"].map((profile) => path.join(ROOT, "target", profile, name)).find(fs.existsSync);
      if (!local) throw new Error(`Build the Rust programs first: cargo build -p liquid-guardian -p liquid-server`);
      fs.copyFileSync(local, path.join(app, "bin", `${name}-${platform}`));
    }
  }
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, private: true }, null, 2) + "\n");
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
