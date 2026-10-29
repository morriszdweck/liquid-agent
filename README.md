# Liquid Agent

A private AI agent for your Mac that runs **LFM3 1.7B** and **LFM3 Omni 2B** entirely on your computer, with a clean web interface in your browser.

- **Chat** with full Markdown: tables, code with highlighting and copy buttons, math, task lists.
- **Does things on your Mac**: runs commands, reads and writes files, searches and reads the web, opens apps and links, sets reminders, uses the clipboard, and clicks around websites with [Betterwright](https://www.npmjs.com/package/betterwright).
- **Voice chat** with LFM3 Omni 2B: it listens, thinks and talks back in one model. Talk over it to interrupt.
- **Omni where it matters**: dictation, reading answers aloud, pictures, audio and your screen all go through LFM3 Omni 2B. Everyday text and documents go to LFM3 1.7B. The app picks the model for you.
- **Three safety modes**: *Ask for Approval*, *Approve for Me* (the [Auto 200M INT4](https://huggingface.co/ProCreations/auto-200m-2-int4) classifier approves safe actions and asks you about the rest) and *Full Auto*. Commands that could wipe data always ask.
- **Memory and For You**: it learns small facts about you, uses only the relevant ones (to keep prompts short) and suggests ideas based on them.
- **Routines** you can run with one click or on a schedule, and an **Activity** log of every action and who approved it.
- **One-click downloads** inside the app. No model picker, no terminal.

Everything stays on your Mac. The only network traffic is the one-time downloads and web searches you ask for.

## Start

Double-click **Liquid Agent.command**. The first time, it gets what it needs (Node.js if you don't have it, then the app), then opens your browser at <http://127.0.0.1:8170>. The welcome screen downloads the models with one button.

Or from a terminal:

```bash
npm ci && npm run build && npm start
```

Requirements: an Apple silicon Mac with macOS 14 or later and about 4 GB of free space for everything (1.1 GB for text chat only).

## What gets downloaded

| Part | What it is | Size |
| --- | --- | --- |
| AI engine | [llama.cpp](https://github.com/ggml-org/llama.cpp) server, latest release | ~30 MB |
| Everyday brain | LFM3 1.7B (GGUF) | 1.1 GB |
| Eyes and ears | LFM3 Omni 2B with its audio and vision parts | 1.6 GB |
| Safety helper | Auto 200M INT4, run with Python through `uv` | ~900 MB |
| Web helper | Betterwright and its browser | ~250 MB |

Files live in `~/Library/Application Support/LiquidAgent`. Settings → Downloads can remove any part.

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
