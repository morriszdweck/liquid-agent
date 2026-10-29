# Liquid Agent

A private AI agent for your Mac that runs **LFM3 1.7B** and **LFM3 Omni 2B** entirely on your computer, with a clean web interface in your browser.

- **Chat** with full Markdown: tables, code with highlighting and copy buttons, math, task lists.
- **Does things on your Mac**: runs commands, reads and writes files, searches and reads the web, opens apps and links, sets reminders, uses the clipboard, and clicks around websites with [Betterwright](https://www.npmjs.com/package/betterwright).
- **Voice chat** with LFM3 Omni 2B: it listens, thinks and talks back in one model. Talk over it to interrupt.
- **Omni where it matters**: dictation, reading answers aloud, pictures, audio and your screen all go through LFM3 Omni 2B. Everyday text and documents go to LFM3 1.7B. The app picks the model for you.
- **Thinks first**: LFM3 1.7B reasons before it answers (turn it off with **Think** under the message box). LFM3 Omni 2B is a non-reasoning model, so pictures and audio are answered right away.
- **Three safety modes**: *Ask for Approval*, *Approve for Me* and *Full Auto*. Approve for Me needs the [Auto 200M INT4](https://huggingface.co/ProCreations/auto-200m-2-int4) classifier, which approves safe actions and asks you about the rest; picking it downloads Auto 200M first. Commands that could wipe data always ask.
- **Memory and For You**: it learns small facts about you, uses only the relevant ones (to keep prompts short) and suggests ideas based on them.
- **Routines** you can run with one click or on a schedule, and an **Activity** log of every action and who approved it.
- **One-click downloads** inside the app, with a choice of model size (Smaller, Balanced, Best, or any GGUF quant in Settings). No model picker: it routes each message itself.

Everything stays on your Mac. The only network traffic is the one-time downloads and web searches you ask for.

## Install

Paste this into Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh | bash
```

It installs the app in `~/.liquid-agent` (with a private copy of Node.js if you don't have one), adds **Liquid Agent** to your Applications folder and a `liquid-agent` command, then opens the setup screen in your browser at <http://127.0.0.1:8170>. Pick what to download and a model size there; that's it.

Afterwards, open it from Applications or Spotlight, or with `liquid-agent`. `liquid-agent update` gets the newest version, `liquid-agent stop` stops it.

Requirements: an Apple silicon Mac with macOS 14 or later and about 4 GB of free space for everything (1.1 GB for text chat only).

From a clone instead: double-click **Liquid Agent.command**, or run `npm ci && npm run build && npm start`.

## What gets downloaded

| Part | What it is | Size |
| --- | --- | --- |
| AI engine | [llama.cpp](https://github.com/ggml-org/llama.cpp) server, latest release | ~30 MB |
| Everyday brain | [LFM3 1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) (GGUF, QAD-Q4_0 to F16) | 1.05–3.5 GB |
| Eyes and ears | [LFM3 Omni 2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF) (Q4_0 to F16) plus its audio and vision projector | 1.6–4 GB |
| Safety helper | Auto 200M INT4, run with Python through `uv` | ~900 MB |
| Web helper | Betterwright and its browser | ~250 MB |

Files live in `~/Library/Application Support/LiquidAgent`. Settings → Downloads switches model sizes (the old size keeps answering until the new one is ready) and removes any part.

## How it works

```
browser ──HTTP/WebSocket──▶ server/ (Node, 127.0.0.1:8170)
                              ├─ llama-server  LFM3 1.7B      :8180
                              ├─ llama-server  LFM3 Omni 2B   :8181  (chat, ASR, TTS, realtime voice)
                              ├─ guardian/     Auto 200M      :8766
                              └─ bridge/       Betterwright   :8767
```

- `server/agent.js` runs the agent loop. LFM3 writes tool calls in its native format; `server/toolparser.js` reads that and the other common forms.
- `server/prompt.js` keeps prompts small: a short system prompt, only relevant memories, and older tool results trimmed to fit the context budget.
- `server/voice.js` bridges the browser microphone to Omni's realtime API and runs tools in the middle of a conversation.
- `web/` is a React app built with Vite into `web/dist`, which the server hosts.

The server only accepts requests from this computer, from its own page, carrying a token that changes every launch.

## Develop

```bash
npm ci
npm run dev        # rebuilds the UI and restarts the server on changes
npm run typecheck
```

## License

MIT
