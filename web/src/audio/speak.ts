// Read aloud with Omni's voice. Long replies are spoken sentence by sentence,
// fetching the next piece while the current one plays.

import { speakAudio } from "../api";
import { errorToast, useStore } from "../store";

let controller: AbortController | null = null;
let audio: HTMLAudioElement | null = null;

/** Turns Markdown into something pleasant to hear. */
export function plain(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code shown on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?[-: |]+\|?\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>#]/g, "")
    .replace(/\$\$?([^$]+)\$\$?/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function chunks(text: string, max = 250) {
  const sentences = text.match(/[^.!?。]+[.!?。]+["')\]]*\s*|[^.!?。]+$/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > max && current) {
      out.push(current.trim());
      current = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
    } else current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function stopSpeaking() {
  controller?.abort();
  controller = null;
  audio?.pause();
  audio = null;
  useStore.setState({ speaking: null });
}

export async function speak(id: string, markdown: string) {
  stopSpeaking();
  const text = plain(markdown);
  if (!text) return;
  const mine = new AbortController();
  controller = mine;
  useStore.setState({ speaking: id });
  const voice = useStore.getState().settings?.voice;
  const parts = chunks(text);
  try {
    let pending = speakAudio(parts[0], voice, mine.signal);
    for (let i = 0; i < parts.length; i++) {
      const blob = await pending;
      if (i + 1 < parts.length) pending = speakAudio(parts[i + 1], voice, mine.signal);
      if (mine.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      audio = new Audio(url);
      await new Promise<void>((resolve, reject) => {
        audio!.onended = () => resolve();
        audio!.onerror = () => reject(new Error("Couldn't play the audio."));
        mine.signal.addEventListener("abort", () => resolve(), { once: true });
        audio!.play().catch(reject);
      });
      URL.revokeObjectURL(url);
      if (mine.signal.aborted) return;
    }
  } catch (e) {
    if (!mine.signal.aborted) errorToast(e);
  } finally {
    if (controller === mine) {
      controller = null;
      useStore.setState({ speaking: null });
    }
  }
}
