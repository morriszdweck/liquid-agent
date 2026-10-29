# Liquid Agent

A private AI agent for your Mac, built for **LFM3 1.7B** and **LFM3 Omni 2B**. It's as easy to use as ChatGPT, it can do things on your Mac for you, and it runs entirely on your computer.

Inspired by Hermes, Muse and Grok.

## So easy anyone can use it

1. Open Liquid Agent.
2. Click **Set up everything**.
3. Start chatting.

There's no Terminal and no picking models. The app downloads what it needs, starts it, and picks the right brain for each request.

## Features

- **Chat.** ChatGPT-style chat with streaming replies, search, rename and export (Markdown). Each reply has copy, read-aloud and try-again buttons.
- **Voice chat.** A full-screen, hands-free conversation: you talk, it answers out loud, then listens again. Speech recognition runs on-device.
- **Look at my screen.** One click takes a screenshot and Omni explains or helps with what's on it.
- **Attachments.** Drag in pictures or files. Pictures go to Omni; text files are read into the chat.
- **For You.** Personalized idea cards based on what the agent remembers about you.
- **Memory.** The agent remembers useful facts about you. You can see, add and delete them.
- **Routines.** One-click tasks such as a morning briefing, tidying Downloads, today's news or a Mac health check. Any routine can run every day at a set time.
- **Activity.** A log of every action the agent took and who approved it.
- **Menu bar quick ask.** Ask a question from the menu bar without opening the window.
- **Notifications.** You get a notification when a task finishes or the agent needs your OK. Reminders can be set by voice or text.
- **Personality.** Choose Friendly, Concise, Playful or Professional. The agent can also greet you by name.
- **Tools.** Shell, files, open apps and websites, web search, a Betterwright browser (go to a page, read, click, type), memory, clipboard and reminders.
- **Automatic model choice.** LFM3 Omni 2B handles pictures and the screen. LFM3 1.7B handles everything else, because it's faster.
- **Three approval modes.**
  - **Ask for Approval:** asks before every action.
  - **Approve for Me:** [Auto 200M INT4](https://huggingface.co/ProCreations/auto-200m-2-int4) runs anything it judges safe and asks you about the rest.
  - **Full Auto:** runs everything, but risky shell commands still ask you.
- **Token efficient.**
  - The system prompt is about 250 tokens.
  - History is fitted to a token budget, newest first, and older tool results are trimmed.
  - Only memory facts relevant to the request are included, and only the newest image is sent.
  - Unavailable tools are left out of the prompt.
  - Browser pages come back as compact text plus a list of buttons and links.
- **Local only.** All servers listen on 127.0.0.1, and the app refuses any endpoint that isn't on your Mac.

## What gets downloaded (once)

| Part | What it is | Size | Source |
|---|---|---|---|
| AI engine | latest llama.cpp (needed for the `lfm3` architecture) | ~30 MB | GitHub |
| Everyday brain | `LiquidAI/LFM3-1.7B-GGUF` Q4_K_M | 1.1 GB | Hugging Face |
| Eyes and ears | `LiquidAI/LFM3-Omni-2B-GGUF` Q4_K_M + mmproj Q8_0 | 1.6 GB | Hugging Face |
| Safety helper | `ProCreations/auto-200m-2-int4` + a private Python (via uv) | ~900 MB | Hugging Face, GitHub |
| Web helper | Betterwright + its browser + a private Node.js | ~250 MB | npm, nodejs.org |

Everything is stored in `~/Library/Application Support/LiquidAgent/`. You can remove any part in Settings → Downloads.

## Build from source

You need macOS 14 or later and Swift 5.10 or later (Xcode or the Command Line Tools).

```bash
git clone https://github.com/morriszdweck/liquid-agent && cd liquid-agent
./scripts/build-app.sh
open "build/Liquid Agent.app"
```

From the terminal, `LiquidAgent --install engine,small,omni,guardian,browser` installs parts without the UI. `scripts/start-backends.sh` is a developer path that runs servers from the repo.

## Architecture

```
Sources/LiquidAgent/
  AppState.swift      agent loop, auto model routing, approvals, voice, routines, activity
  Backends.swift      downloads, installs and runs every local part
  Downloader.swift    file downloads with progress
  Agent.swift         prompt builder + token-budget packing
  ToolParser.swift    LFM / pythonic / JSON tool-call parser
  Tools.swift         tool registry
  Guardian.swift      Auto 200M client + hard safety rules
  Browser.swift       Betterwright bridge client
  Memory.swift        user facts + idea generation
  Voice.swift         on-device speech in and out
  Views/              chat, voice, For You, routines, memory, activity, setup, settings
guardian/server.py    Auto 200M INT4 sidecar (uses the repo's auto_quant.py)
bridge/server.mjs     Betterwright sidecar
```

## License

MIT
