// LFM3 Omni 2B helpers: hearing (ASR), seeing (images) and speaking (TTS).

import { MODELS, isLocal, settings } from "./core.js";
import { complete } from "./llm.js";

const omni = () => ({ url: settings.omniURL, model: MODELS.omni.id, temperature: 0 });

/** Transcribes a WAV file (any rate; 16 kHz mono is best). */
export async function transcribe(wav, { signal } = {}) {
  const text = await complete({
    ...omni(),
    signal,
    maxTokens: 512,
    messages: [
      { role: "system", content: "Perform ASR in English." },
      { role: "user", content: [{ type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } }] },
    ],
  });
  return text.replace(/^["“]|["”]$/g, "").trim();
}

/** Answers a question about a picture. */
export async function look(image, mime, question, { signal } = {}) {
  return complete({
    ...omni(),
    signal,
    maxTokens: 600,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
          { type: "text", text: question || "Describe this in detail." },
        ],
      },
    ],
  });
}

/** Speaks text. Returns a 24 kHz mono WAV. */
export async function speak(text, voice = settings.voice, { signal } = {}) {
  const base = new URL(settings.omniURL).origin;
  if (!isLocal(base)) throw new Error("Refusing a model address that isn't on this computer.");
  const res = await fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, voice }),
    signal,
  });
  if (!res.ok) throw new Error(`Speech failed (HTTP ${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}
