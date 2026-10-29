// Streaming client for the local llama.cpp servers (OpenAI-compatible API).

import { isLocal } from "./core.js";

/**
 * Streams a chat completion. Yields {reasoning} while the model thinks (only
 * with think on), {content}, then {usage} and {timings} when the server reports them.
 */
export async function* stream({ url, model, messages, temperature = 0.3, maxTokens = 1024, stop, think = false, signal }) {
  if (!isLocal(url)) throw new Error("Refusing a model address that isn't on this computer.");
  let res;
  try {
    res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stop,
        stream: true,
        stream_options: { include_usage: true },
        cache_prompt: true,
        chat_template_kwargs: { enable_thinking: think },
      }),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error("The model isn't answering. It may still be starting; try again in a moment.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = body;
    try {
      message = JSON.parse(body).error?.message ?? body;
    } catch {}
    if (/context|exceed/i.test(message)) throw new Error("This chat got too long for the model. Start a new chat.");
    throw new Error(`The model returned an error (HTTP ${res.status}). ${message}`.slice(0, 400));
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = event.choices?.[0]?.delta;
      if (delta?.reasoning_content) yield { reasoning: delta.reasoning_content };
      if (delta?.content) yield { content: delta.content };
      if (event.usage) yield { usage: event.usage };
      if (event.timings) yield { timings: event.timings };
    }
  }
}

/** Collects a whole completion as text. */
export async function complete(options) {
  let text = "";
  for await (const part of stream(options)) if (part.content) text += part.content;
  return text.trim();
}
