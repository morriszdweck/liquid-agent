# Liquid Agent

A private AI agent for your Mac or Linux computer that runs **LFM3 1.7B** and **LFM3 Omni 2B** entirely on your computer, with a clean web interface in your browser.

- **Chat** with full Markdown: tables, code with highlighting and copy buttons, math, task lists.
- **Does things on your computer**: runs commands, reads and writes files, searches and reads the web, opens apps and links, sets reminders, uses the clipboard, and clicks around websites with [Betterwright](https://www.npmjs.com/package/betterwright).
- **Voice chat** with LFM3 Omni 2B: it listens, thinks and talks back in one model. Talk over it to interrupt. Turn on the camera and it also sees what you show it.
- **Omni where it matters**: dictation, reading answers aloud, pictures, audio and your screen all go through LFM3 Omni 2B. Everyday text and documents go to the Everyday brain (LFM3 1.7B). The app picks the model for you.
- **Thinks first**: the built-in LFM3 1.7B reasons before every answer. The reasoning stays folded away; tap **Thinking for a better answer…** to read it. LFM3 Omni 2B, or a custom model whose template has no thinking mode, answers right away.
- **Three safety modes**: *Ask for Approval*, *Approve for Me* and *Full Auto*. Approve for Me needs the [Auto 200M INT4](https://huggingface.co/ProCreations/auto-200m-2-int4) classifier, which approves safe actions and asks you about the rest; picking it downloads Auto 200M first. Commands that could wipe data always ask.
- **Memory and For You**: it learns small facts about you, uses only the relevant ones (to keep prompts short) and suggests ideas based on them.
- **Routines** you can run with one click or on a schedule, and an **Activity** log of every action and who approved it.
- **One-click downloads** inside the app, with a choice of model size (Smaller, Balanced, Best, or any GGUF quant in Settings). The app still routes each message itself.

Everything stays on your computer. The only network traffic is the one-time downloads and web searches you ask for.

## Install

Paste this into Terminal on macOS, or a terminal on Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh | bash
```

It installs a ready-to-run copy in `~/.liquid-agent` (no npm or build step, and a private copy of Node.js if you don't have one), adds **Liquid Agent** to your Applications folder (or app menu on Linux) and a `liquid-agent` command, then opens the setup screen in your browser at <http://127.0.0.1:8170>. Pick what to download and a model size there; that's it.

Afterwards, open it from Applications, Spotlight or your app menu, or with `liquid-agent`. `liquid-agent stop` stops it.

It keeps itself up to date: every push to `main` is published as a release, new versions download in the background and go in when nothing is running, and if one doesn't start the previous version comes back. Turn this off in Settings → General; `liquid-agent update` gets the newest version right away.

Requirements: an Apple silicon Mac with macOS 14 or later, or a 64-bit Linux computer (see [Linux](#linux)), and about 4 GB of free space for everything (1.1 GB for text chat only).

From a clone instead (it won't update itself; use `git pull`): double-click **Liquid Agent.command** on macOS, run `scripts/start.sh`, or run `npm ci && npm run build && npm start` (Node.js 22 or newer).

## Linux

The same command installs it on Linux. It needs a 64-bit Intel, AMD or ARM computer with glibc 2.35 or newer (Ubuntu 22.04, Debian 12, Fedora 36 or later, and most distributions since 2022). It keeps its files in `~/.local/share/liquid-agent` (or `$XDG_DATA_HOME/liquid-agent`) and adds a `.desktop` entry to your app menu.

**Speed.** The AI engine picks the fastest build it can use:

- **Vulkan** when your graphics driver supports it (most AMD, Intel and NVIDIA GPUs with current drivers). Nothing extra to install.
- **CPU** otherwise. It works everywhere, just slower.
- **CUDA** for NVIDIA cards, if you ask for it with `LIQUID_AGENT_GPU=cuda liquid-agent` (driver 525 or newer). It downloads about 600 MB more.

`LIQUID_AGENT_GPU=vulkan` or `LIQUID_AGENT_GPU=cpu` picks one of the others; then remove and reinstall the AI engine in Settings → Downloads. If the GPU build can't start a model, Liquid Agent restarts it on the CPU by itself.

**Optional extras.** Everything works without these. They add the clipboard, screenshots, audio files and reminder pop-ups. On Ubuntu and Debian (other distributions have the same packages, with `libnotify` in place of `libnotify-bin`):

```bash
sudo apt install wl-clipboard xclip ffmpeg libnotify-bin imagemagick pandoc
```

Screenshots use `grim` on Wayland (or GNOME's and KDE's own screenshot tools, or the desktop's screenshot portal, which asks you first) and `import`, `scrot` or `maim` on X11.

**Not yet on Linux:** the Web helper's browser needs an x86_64 computer, and the safety helper uses the CPU version of PyTorch.

## What gets downloaded

| Part | What it is | Size |
| --- | --- | --- |
| AI engine | [llama.cpp](https://github.com/ggml-org/llama.cpp) server, latest release | ~30 MB |
| Everyday brain | [LFM3 1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) (GGUF, QAD-Q4_0 to F16) | 1.05–3.5 GB |
| Eyes and ears | [LFM3 Omni 2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF) (Q4_0 to F16) plus its audio and vision projector | 1.6–4 GB |
| Safety helper | Auto 200M INT4, run with Python through `uv` | ~900 MB |
| Web helper | Betterwright and its browser | ~250 MB |

Files live in `~/Library/Application Support/LiquidAgent` on macOS and `~/.local/share/liquid-agent` on Linux. Settings → Downloads switches model sizes (the old size keeps answering until the new one is ready) and removes any part.

**Advanced: your own model.** Settings → Advanced → Everyday brain model → **Use a model from Hugging Face** takes a link such as `https://huggingface.co/<org>/<model>-GGUF`. Liquid Agent reads the repository's GGUF list, groups split files, picks a size that should fit this computer, checks the GGUF header and chat template, and runs it on the same llama.cpp engine. A `blob` link to one `.gguf` file preselects that file. Public repositories work directly; for a gated or private one, accept its terms on Hugging Face and set `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) before starting Liquid Agent. Only text GGUF models are used here; vision/audio projectors are skipped. Switch back to the built-in LFM3 1.7B at any time. A model you add hasn't been tested with Liquid Agent's tools, so while it answers, Full Auto works like Approve for Me and Auto 200M checks each action.

## How it works

```
browser ──HTTP/WebSocket──▶ server/ (Node, 127.0.0.1:8170)
                              ├─ llama-server  Everyday brain :8180  (LFM3 1.7B or your GGUF)
                              ├─ llama-server  LFM3 Omni 2B   :8181  (chat, ASR, TTS, realtime voice)
                              ├─ guardian/     Auto 200M      :8766
                              └─ bridge/       Betterwright   :8767
```

- `server/agent.js` runs the agent loop. LFM3 writes tool calls in its native format; `server/toolparser.js` reads that and the other common forms.
- `server/models.js` reads Hugging Face links, finds and groups GGUF files, picks a size for this computer and checks a model's header before it runs.
- `server/prompt.js` keeps prompts small: a short system prompt, only relevant memories, and older tool results trimmed to fit the context budget.
- `server/voice.js` bridges the browser microphone to Omni's realtime API and runs tools in the middle of a conversation.
- `web/` is a React app built with Vite into `web/dist`, which the server hosts.

The server only accepts requests from this computer, from its own page, carrying a token that changes every launch.

## Develop

```bash
npm ci
npm run dev        # rebuilds the UI and restarts the server on changes
npm run typecheck
npm test           # starts the server and checks its API
node scripts/bundle.mjs --build 1   # packs release/liquid-agent.tar.gz and latest.json, as CI does for releases
```

## License

MIT
