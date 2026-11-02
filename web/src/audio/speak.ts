// Read aloud with Omni's voice. Long replies are spoken sentence by sentence,
// fetching the next piece while the current one plays.

import { speakAudio } from "../api";
import { errorToast, useStore } from "../store";
import { chunks, plain } from "./text";

export { plain } from "./text";

let controller: AbortController | null = null;
let audio: HTMLAudioElement | null = null;

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
  let url: string | null = null;
  // A piece is fetched while the one before it plays. Its handler is attached at once, so a failure
  // during playback is reported when it is awaited, not as an unhandled rejection.
  const fetchPiece = (piece: string) => {
    const request = speakAudio(piece, voice, mine.signal, text.slice(0, 8000));
    request.catch(() => {});
    return request;
  };
  try {
    let pending = fetchPiece(parts[0]);
    for (let i = 0; i < parts.length; i++) {
      const blob = await pending;
      if (i + 1 < parts.length) pending = fetchPiece(parts[i + 1]);
      if (mine.signal.aborted) return;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      await new Promise<void>((resolve, reject) => {
        audio!.onended = () => resolve();
        audio!.onerror = () => reject(new Error("Couldn't play the audio."));
        mine.signal.addEventListener("abort", () => resolve(), { once: true });
        audio!.play().catch(reject);
      });
      URL.revokeObjectURL(url);
      url = null;
      if (mine.signal.aborted) return;
    }
  } catch (e) {
    if (!mine.signal.aborted) errorToast(e);
  } finally {
    // A stopped clip keeps its object URL until here; release it now.
    if (url) URL.revokeObjectURL(url);
    if (controller === mine) {
      controller = null;
      useStore.setState({ speaking: null });
    }
  }
}
