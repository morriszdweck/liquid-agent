// Voice chat: the browser streams microphone audio here and this bridges it to
// LFM3 Omni 2B's realtime API, which listens, thinks and talks back in one model.
//
// Browser -> server: {type:"start", chatId?}, binary PCM16 mono at inputRate,
//                    {type:"commit"} at the end of an utterance, {type:"text", text},
//                    {type:"frame", image} with a base64 JPEG while the camera is on,
//                    {type:"cancel"} to interrupt, {type:"stop"}.
//
// The realtime API takes only audio and text, so camera frames go to Omni's other slot,
// which describes the newest one; the description joins the turn as a short note.
// Server -> browser: {type:"ready", inputRate, outputRate, chatId}, {type:"state", state},
//                    {type:"user", text}, {type:"assistant", text}, {type:"tool", label, status},
//                    binary PCM16 mono at outputRate, {type:"turn.done"}, {type:"error", message}.

import WebSocket from "ws";
import { settings } from "./core.js";
import { agent } from "./agent.js";
import { backends } from "./backends.js";
import { look, transcribe } from "./omni.js";
import { voiceInstructions } from "./prompt.js";
import { activeTools, runTool, schema, toolMap } from "./tools.js";

const MAX_REPLY_SECONDS = 45;
// How long a turn waits for the newest camera frame to be described.
const LOOK_WAIT_MS = 2500;
const LOOK =
  "This is a frame from the user's camera during a voice call. In one or two short sentences, say what it shows: people and what they are doing, anything held up to the camera, readable text and the setting. No preamble.";

function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Open voice calls, so an update waits until they end. */
export const voiceCalls = new Set();

export function handleVoice(client) {
  voiceCalls.add(client);
  const controller = new AbortController();
  let upstream = null;
  let chat = null;
  let inputRate = 16000;
  let outputRate = 24000;
  let heard = [];
  let user = null;
  let reply = null;
  let calls = [];
  let responding = false;
  let createQueued = false;
  let audioBytes = 0;
  let throttle = 0;
  let frameSeq = 0; // camera frames received
  let usedSeq = 0; // frames an earlier turn already covered
  let looking = null; // { seq, done } for the frame being described
  let nextFrame = null; // { seq, jpeg }, the newest frame that came in meanwhile
  let seen = { seq: 0, text: "" };

  const send = (obj) => client.readyState === 1 && client.send(JSON.stringify(obj));
  const up = (obj) => upstream?.readyState === 1 && upstream.send(JSON.stringify(obj));
  const state = (s) => send({ type: "state", state: s });
  const fail = (message) => send({ type: "error", message });

  function createResponse() {
    if (responding) {
      createQueued = true;
      return;
    }
    responding = true;
    audioBytes = 0;
    up({ type: "response.create" });
    state("thinking");
  }

  function beginTurn(text) {
    if (reply) finishTurn();
    user = { id: agent.uid(), role: "user", content: text, voice: true, attachments: [], at: Date.now() };
    reply = { id: agent.uid(), role: "assistant", content: "", steps: [], status: "streaming", model: "omni", voice: true, at: Date.now() };
    chat.messages.push(user, reply);
    agent.emitChat(chat);
  }

  function finishTurn(status = "done") {
    if (!reply) return;
    reply.status = status;
    reply.content = reply.content.trim();
    if (!reply.content && !reply.steps.length) {
      chat.messages = chat.messages.filter((m) => m !== reply);
      if (!user?.content || user.content === "…") chat.messages = chat.messages.filter((m) => m !== user);
    }
    agent.emitChat(chat);
    reply = null;
    send({ type: "turn.done" });
  }

  async function start({ chatId }) {
    if (!backends.running("omni")) {
      const waking = backends.states.omni?.status === "starting";
      return fail(
        waking
          ? "Eyes and ears is still waking up. Try again in a few seconds."
          : "Voice chat needs the Eyes and ears part. Set it up in Settings → Downloads.",
      );
    }
    chat = (chatId && agent.chat(chatId)) || agent.create({ title: "Voice chat", source: "voice" });
    if (chat.messages.length === 0) chat.named = true;
    upstream = new WebSocket(`${settings.omniURL.replace(/^http/, "ws")}/realtime`);
    upstream.on("message", (data) => {
      try {
        onEvent(JSON.parse(data));
      } catch (e) {
        fail(String(e?.message ?? e));
      }
    });
    upstream.on("error", () => fail("Couldn't reach the voice service."));
    upstream.on("close", () => {
      finishTurn("stopped");
      if (client.readyState === 1) client.close();
    });
  }

  function onEvent(event) {
    switch (event.type) {
      case "session.created": {
        const audio = event.session?.audio;
        inputRate = audio?.input?.format?.rate ?? 16000;
        outputRate = audio?.output?.format?.rate ?? 24000;
        up({
          type: "session.update",
          session: {
            instructions: voiceInstructions(chat.messages.filter((m) => m.content)),
            tools: activeTools().map(schema),
            tool_choice: "auto",
            output_modalities: ["text", "audio"],
            max_output_tokens: 400,
          },
        });
        send({ type: "ready", inputRate, outputRate, chatId: chat.id });
        state("listening");
        return;
      }
      case "response.output_text.delta":
        if (!reply) return;
        reply.content += event.delta ?? "";
        send({ type: "assistant", text: reply.content });
        if (Date.now() - throttle > 250) {
          throttle = Date.now();
          agent.emitChat(chat);
        }
        return;
      case "response.output_audio.delta": {
        if (!reply) return;
        const pcm = Buffer.from(event.delta ?? "", "base64");
        audioBytes += pcm.length;
        if (audioBytes > outputRate * 2 * MAX_REPLY_SECONDS) {
          up({ type: "response.cancel" });
          return;
        }
        if (audioBytes === pcm.length) state("speaking");
        if (client.readyState === 1) client.send(pcm);
        return;
      }
      case "response.function_call_arguments.done":
        calls.push({ id: event.call_id, name: event.name, args: event.arguments });
        return;
      case "response.done": {
        responding = false;
        const cancelled = event.response?.status === "cancelled";
        const pending = cancelled ? [] : calls;
        calls = [];
        if (createQueued) {
          createQueued = false;
          createResponse();
          return;
        }
        if (pending.length && reply) runCalls(pending).catch((e) => fail(String(e?.message ?? e)));
        else finishTurn(cancelled ? "stopped" : "done");
        return;
      }
      case "error":
        fail(event.error?.message ?? "Voice error.");
        if (!responding) state("listening");
        return;
    }
  }

  async function runCalls(pending) {
    state("working");
    for (const call of pending) {
      let args = {};
      try {
        args = JSON.parse(call.args || "{}");
      } catch {}
      const tool = toolMap.get(call.name);
      let output;
      if (!tool) {
        output = `Unknown tool ${call.name}.`;
      } else {
        const s = { id: agent.uid(), tool: call.name, args, label: tool.label(args), note: reply.content.trim(), status: "pending", at: Date.now() };
        reply.content = "";
        reply.steps.push(s);
        agent.emitChat(chat);
        send({ type: "tool", label: s.label, status: "pending" });
        const verdict = await agent.decide(chat, reply, s, user?.content ?? "", controller.signal);
        s.decision = verdict.decision;
        if (!verdict.approved) {
          s.status = "denied";
          output = "The user said no to this action.";
          agent.record(chat, s, false);
        } else {
          s.status = "running";
          agent.emitChat(chat);
          const result = await runTool(s.tool, args, { signal: controller.signal, chatId: chat.id });
          Object.assign(s, { status: result.ok ? "done" : "error", result: result.text, ms: Date.now() - s.at });
          agent.record(chat, s, result.ok);
          output = result.text;
        }
        agent.emitChat(chat);
        send({ type: "tool", label: s.label, status: s.status });
      }
      up({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.id, output } });
    }
    createResponse();
  }

  function describe(frame) {
    const done = look(frame.jpeg, "image/jpeg", LOOK, { signal: controller.signal, maxTokens: 120 })
      .then((text) => {
        if (frame.seq > seen.seq && text.trim()) seen = { seq: frame.seq, text: text.trim().replace(/\s+/g, " ") };
      })
      .catch(() => {})
      .finally(() => {
        looking = null;
        if (nextFrame) {
          const next = nextFrame;
          nextFrame = null;
          describe(next);
        }
      });
    looking = { seq: frame.seq, done };
  }

  function onFrame(image) {
    if (typeof image !== "string" || image.length > 3_000_000) return;
    const jpeg = Buffer.from(image, "base64");
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return;
    const frame = { seq: ++frameSeq, jpeg };
    if (looking) nextFrame = frame;
    else describe(frame);
  }

  /** What the camera showed since the last turn, after a short wait for the newest frame. */
  async function cameraNote() {
    const upto = frameSeq;
    const from = usedSeq;
    if (upto === from) return "";
    usedSeq = upto;
    const until = Date.now() + LOOK_WAIT_MS;
    const busy = () => (looking && looking.seq <= upto) || (nextFrame && nextFrame.seq <= upto);
    while (busy() && Date.now() < until) await Promise.race([looking.done, new Promise((r) => setTimeout(r, until - Date.now()))]);
    return seen.seq > from ? `(On camera right now: ${seen.text})` : "";
  }

  async function commit() {
    const audio = Buffer.concat(heard);
    heard = [];
    if (audio.length < inputRate * 2 * 0.3) {
      up({ type: "input_audio_buffer.clear" });
      return;
    }
    beginTurn("…");
    const turnUser = user;
    const turnReply = reply;
    up({ type: "input_audio_buffer.commit" });
    // A commit leaves the user's turn open, so the camera note joins the same message.
    const note = await cameraNote();
    if (reply !== turnReply) return; // interrupted meanwhile
    if (note) up({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: note }] } });
    createResponse();
    // The realtime session doesn't return what it heard, so Omni's second slot transcribes it.
    transcribe(wav(audio, inputRate), { signal: controller.signal })
      .then((text) => {
        turnUser.content = text || "(voice message)";
        send({ type: "user", text: turnUser.content });
        agent.emitChat(chat);
      })
      .catch(() => {
        turnUser.content = "(voice message)";
        agent.emitChat(chat);
      });
  }

  async function typed(text) {
    beginTurn(text);
    const turnReply = reply;
    const note = await cameraNote();
    if (reply !== turnReply) return;
    up({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: note ? `${text}\n\n${note}` : text }] } });
    createResponse();
  }

  client.on("message", (data, binary) => {
    if (binary) {
      if (!upstream) return;
      const pcm = Buffer.from(data);
      heard.push(pcm);
      up({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "start" && !upstream) start(msg);
    else if (msg.type === "commit") commit();
    else if (msg.type === "frame" && upstream) onFrame(msg.image);
    else if (msg.type === "text" && String(msg.text ?? "").trim()) typed(String(msg.text).trim());
    else if (msg.type === "cancel") {
      heard = [];
      if (responding) up({ type: "response.cancel" });
      if (reply) {
        reply.interrupted = true;
        finishTurn("done");
      }
      state("listening");
    } else if (msg.type === "stop") client.close();
  });

  client.on("close", () => {
    voiceCalls.delete(client);
    controller.abort();
    finishTurn("stopped");
    upstream?.close();
    // A call where nobody said anything shouldn't leave an empty chat behind.
    if (chat && chat.messages.length === 0) agent.remove(chat.id);
  });
}
