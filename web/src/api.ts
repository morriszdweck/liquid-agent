// Talks to the local server. Every call carries the per-launch token the server
// put in the page, so other websites can't drive the agent.

export const token = document.querySelector<HTMLMetaElement>('meta[name="liquid-token"]')?.content ?? "";

export class ApiError extends Error {}

async function request(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "X-Liquid-Token": token, ...(init.headers as Record<string, string>) };
  let payload = init.body;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { ...init, method, headers, body: payload });
  if (res.status === 401) {
    // The server restarted with a new token.
    location.reload();
    throw new ApiError("Reconnecting…");
  }
  if (!res.ok) {
    let message = `Something went wrong (${res.status}).`;
    try {
      message = (await res.json()).error ?? message;
    } catch {}
    throw new ApiError(message);
  }
  return res;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function upload(file: Blob, name: string) {
  const res = await request("POST", "/api/uploads", undefined, {
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(name) },
  });
  return res.json();
}

export async function transcribe(wav: Blob): Promise<string> {
  const res = await request("POST", "/api/transcribe", undefined, { body: wav, headers: { "Content-Type": "audio/wav" } });
  return (await res.json()).text ?? "";
}

export async function speakAudio(text: string, voice?: string, signal?: AbortSignal): Promise<Blob> {
  const res = await request("POST", "/api/speak", { text, voice }, { signal });
  return res.blob();
}

export const fileURL = (id: string) => `/api/uploads/${id}?t=${token}`;

export const socketURL = (path: string) => `ws://${location.host}${path}?t=${token}`;
