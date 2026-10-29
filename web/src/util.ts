import type { Chat } from "./types";

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export function timeAgo(at: number) {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function duration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function bytes(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : `${part}`;
}

/** Groups chats the way chat apps do: pinned, today, yesterday, this week, older. */
export function groupChats(chats: Chat[]) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const groups: [string, Chat[]][] = [
    ["Pinned", []],
    ["Today", []],
    ["Yesterday", []],
    ["Previous 7 days", []],
    ["Older", []],
  ];
  for (const c of chats) {
    const g = c.pinned ? 0 : c.updatedAt >= today ? 1 : c.updatedAt >= today - 86400e3 ? 2 : c.updatedAt >= today - 7 * 86400e3 ? 3 : 4;
    groups[g][1].push(c);
  }
  return groups.filter(([, list]) => list.length);
}

/** Shrinks big pictures before upload: the model sees at most about 1280 px anyway. */
export async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  const max = 1280;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return { blob: file, name: file.name };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000) return { blob: file, name: file.name };
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
    return { blob, name: file.name.replace(/\.\w+$/, "") + ".jpg" };
  } catch {
    return { blob: file, name: file.name };
  }
}

/** Asks the browser to share a screen or window, grabs one frame and stops sharing. */
export async function captureScreen(): Promise<Blob> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 250));
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export function chatMarkdown(chat: Chat) {
  const lines = [`# ${chat.title}`, ""];
  for (const m of chat.messages) {
    lines.push(m.role === "user" ? "## You" : "## Liquid Agent", "");
    for (const s of m.steps ?? []) lines.push(`> ${s.label} (${s.decision ?? s.status})`);
    if (m.steps?.length) lines.push("");
    lines.push(m.content, "");
  }
  return lines.join("\n");
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const modelLabel = (m?: string) => (m === "omni" ? "LFM3 Omni 2B" : "LFM3 1.7B");
