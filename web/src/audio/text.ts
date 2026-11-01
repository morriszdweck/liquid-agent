// Turns a reply into text that reads well aloud, and cuts it into pieces the speech model can say well.

/** Turns Markdown and symbols into something pleasant to hear. */
export function plain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code shown on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s*\|?[-: |]+\|?\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\$\$?([^$]+)\$\$?/g, "$1")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Breaks one sentence into pieces of at most `max` characters, always at a word boundary when it can. */
function wrap(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let line = "";
  for (const word of sentence.split(/\s+/)) {
    if (word.length > max) {
      // A single token longer than a whole piece (a long URL, say) has to be cut.
      if (line) out.push(line);
      line = "";
      for (let i = 0; i < word.length; i += max) out.push(word.slice(i, i + max));
      continue;
    }
    const joined = line ? `${line} ${word}` : word;
    if (joined.length > max) {
      out.push(line);
      line = word;
    } else {
      line = joined;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Cuts text into speakable pieces of at most `max` characters. Sentences are
 * kept whole when they fit, so the voice keeps its intonation, and a long
 * sentence is split at a space, never in the middle of a word.
 */
export function chunks(text: string, max = 250): string[] {
  // Split after sentence punctuation only when a space or the end follows, so "3.5" stays whole.
  const sentences = text.split(/(?<=[.!?])\s+|(?<=[。！？])/);
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    for (const piece of wrap(sentence.trim(), max)) {
      if (!piece) continue;
      const joined = current ? `${current} ${piece}` : piece;
      if (joined.length > max) {
        out.push(current);
        current = piece;
      } else {
        current = joined;
      }
    }
  }
  if (current) out.push(current);
  return out;
}
