# Liquid Agent

A local-only agent for macOS, built for **LFM3 1.7B** and **LFM3 2B Omni**.
Chat like ChatGPT, let the agent act on your Mac, and keep everything on your machine.

Inspired by Hermes, Muse and Grok's companion bot. Its mascot is a glowing circle with two eyes that blink, look around, and react while the agent thinks, works, listens or needs you.

## Features

- **ChatGPT-style UI.** Sidebar of chats, centered conversation, rounded composer, streaming replies, code blocks with copy.
- **Agent harness tuned for small models.** LFM-native tool calls (`<|tool_call_start|>[tool(arg="v")]<|tool_call_end|>`) with pythonic and JSON fallbacks, one call per step, a step limit, and short tool signatures.
- **Token efficient.**
  - The system prompt stays around 250 tokens.
  - History is packed newest-first into a context budget you set.
  - Older tool results are cut to 240 characters, and only the latest one gets the full limit.
  - Only memory facts relevant to the request are included.
  - Only the newest image is sent.
  - Browser pages come back as compact text plus numbered elements instead of raw DOM.
- **Three approval modes.**
  - **Ask for Approval:** asks before every action.
  - **Approve for Me:** [Auto 200M](https://huggingface.co/ProCreations/auto-200m-2) (INT4) judges each tool call. Safe calls run; anything risky, and anything when the guardian is offline, comes to you.
  - **Full Auto:** runs everything. Hard-blocked shell patterns (`sudo`, `rm -rf ~`, piping into `sh`, and similar) still ask you.
- **Betterwright browser.** A persistent [Betterwright](https://pi.dev/packages/betterwright) session via a local bridge, with `browser_goto`, `browser_read`, `browser_click` and `browser_type`. Logins survive between turns.
- **Voice chat.** Hands-free loop: on-device speech recognition, then the agent, then a spoken reply, then listening again. Dictation is also available in the composer.
- **Memory and Ideas.** The agent saves facts about you with `remember`. On launch it generates personalized idea cards from what it knows. You can edit memory in Settings → Memory.
- **Vision.** Attach images when using LFM3 2B Omni.
- **Tools:** shell, read/write/list files, open apps/URLs, browser, remember/recall, clipboard.
- **Local only.** Every endpoint must be `localhost` or `127.0.0.1`. The app refuses anything else, and all sidecars bind to loopback.

## Quick start

Requirements: macOS 14+, Swift 5.10+ (Xcode or Command Line Tools), `llama.cpp` (`brew install llama.cpp`), Python 3.10+, Node 20+.

```bash
git clone https://github.com/morriszdweck/liquid-agent && cd liquid-agent
./scripts/start-backends.sh      # models, guardian, browser bridge
./scripts/build-app.sh           # builds "build/Liquid Agent.app"
open "build/Liquid Agent.app"
```

For development, use `swift run`. Voice needs the bundled `.app`, because macOS requires microphone and speech usage strings.

### Model servers

`start-backends.sh` runs `llama-server -hf` with these defaults. Override them if the repo names differ:

```bash
LA_SMALL_GGUF=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M \
LA_OMNI_GGUF=LiquidAI/LFM3-2B-Omni-GGUF:Q4_K_M \
./scripts/start-backends.sh
```

Any OpenAI-compatible local server works, including Ollama and `mlx_lm.server`. Set the URL and model id in Settings → Models.

| Service | Port |
|---|---|
| LFM3 1.7B | 8080 |
| LFM3 2B Omni | 8081 |
| Auto 200M guardian | 8766 |
| Betterwright bridge | 8767 |

## Architecture

```
Sources/LiquidAgent/
  AppState.swift     agent loop, approval flow, voice loop, persistence
  Agent.swift        prompt builder + token-budget packing
  ToolParser.swift   LFM / pythonic / JSON tool-call parser
  Tools.swift        tool registry
  Guardian.swift     Auto 200M client (model-card input format) + hard rules
  Browser.swift      Betterwright bridge client
  Memory.swift       user facts + idea generation
  Voice.swift        on-device STT/TTS
  Views/             ChatGPT-style UI, mascot, settings
guardian/server.py   Auto 200M sidecar (transformers + optimum-quanto INT4)
bridge/server.mjs    Betterwright sidecar
```

Data lives in `~/Library/Application Support/LiquidAgent/`.

## Status

This is an early release. The LFM3 GGUF repo names and Betterwright's `run()` result envelope are assumptions. Check them against current releases and open an issue if they differ.

## License

MIT
