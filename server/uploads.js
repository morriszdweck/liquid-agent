// Files the user attaches. Pictures and audio go to Omni; documents are read as text.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DIRS, load, run, save } from "./core.js";

export const MAX_UPLOAD = 25 * 1024 * 1024;

const TEXT_EXT = new Set(
  "txt md markdown csv tsv json jsonl yaml yml toml xml html htm css js mjs cjs ts tsx jsx py rb go rs swift java kt c h cpp hpp cs php sh zsh bash sql log ini conf env tex srt vtt".split(" "),
);
const CONVERT_EXT = new Set(["docx", "doc", "rtf", "rtfd", "odt", "webarchive", "pages"]);
const AUDIO_CONVERT = new Set(["m4a", "mp3", "aac", "aiff", "aif", "caf", "flac", "mp4", "mov"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"]);

let index = load("uploads.json", {});
const persist = () => save("uploads.json", index);

const mimeFor = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  wav: "audio/wav",
  pdf: "application/pdf",
};

export const uploads = {
  get(id) {
    return index[id] ?? null;
  },

  file(id) {
    const u = index[id];
    return u && fs.existsSync(u.path) ? u.path : null;
  },

  async add(name, mime, body) {
    const id = crypto.randomUUID();
    const safeName = path.basename(String(name || "file")).replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
    const ext = path.extname(safeName).slice(1).toLowerCase();
    let file = path.join(DIRS.uploads, `${id}${ext ? "." + ext : ""}`);
    fs.writeFileSync(file, body);
    mime = mime || mimeFor[ext] || "application/octet-stream";

    let kind = "other";
    let text;
    if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) {
      kind = "image";
      if (ext === "heic" || ext === "tiff" || ext === "bmp" || mime === "image/heic") {
        const png = path.join(DIRS.uploads, `${id}.png`);
        await run("sips", ["-s", "format", "png", "-Z", "1280", file, "--out", png]);
        fs.rmSync(file, { force: true });
        file = png;
        mime = "image/png";
      }
    } else if (mime.startsWith("audio/") || ext === "wav" || AUDIO_CONVERT.has(ext)) {
      kind = "audio";
      if (ext !== "wav") {
        const wav = path.join(DIRS.uploads, `${id}.wav`);
        await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", file, wav]);
        fs.rmSync(file, { force: true });
        file = wav;
        mime = "audio/wav";
      }
    } else if (mime.startsWith("text/") || TEXT_EXT.has(ext)) {
      kind = "text";
      text = body.toString("utf8");
    } else if (CONVERT_EXT.has(ext)) {
      kind = "text";
      text = await run("textutil", ["-convert", "txt", "-stdout", file]).catch(() => undefined);
      if (text === undefined) kind = "other";
    }
    if (text !== undefined) fs.writeFileSync(file + ".txt", text);

    index[id] = { id, name: safeName, mime, kind, size: fs.statSync(file).size, path: file, at: Date.now() };
    persist();
    return this.public(id);
  },

  /** Text content of a document attachment. */
  text(id) {
    const u = index[id];
    if (!u || u.kind !== "text") return "";
    try {
      return fs.readFileSync(u.path + ".txt", "utf8");
    } catch {
      return "";
    }
  },

  base64(id) {
    const file = this.file(id);
    return file ? fs.readFileSync(file).toString("base64") : null;
  },

  public(id) {
    const u = index[id];
    return u ? { id: u.id, name: u.name, mime: u.mime, kind: u.kind, size: u.size } : null;
  },

  remove(ids) {
    for (const id of ids) {
      const u = index[id];
      if (!u) continue;
      fs.rmSync(u.path, { force: true });
      fs.rmSync(u.path + ".txt", { force: true });
      delete index[id];
    }
    persist();
  },
};
