# Liquid Agent

A private AI agent for your Mac or Linux computer that runs **LFM3 1.7B** and **LFM3 Omni 2B** entirely on your computer, with a clean web interface in your browser.

- **Chat** with full Markdown: tables, code with highlighting and copy buttons, math, task lists.
- **Does things on your computer**: runs commands, reads and writes files, searches and reads the web, opens apps and links, sets reminders, uses the clipboard, and clicks around websites in a headless Chrome.
- **Voice chat** with LFM3 Omni 2B: it listens, thinks and talks back in one model. Talk over it to interrupt. Turn on the camera and it also sees what you show it.
- **Omni where it matters**: dictation, reading answers aloud, pictures, audio and your screen all go through LFM3 Omni 2B. Everyday text and documents go to the Everyday brain (LFM3 1.7B). The app picks the model for you.
- **Thinks first**: the built-in LFM3 1.7B reasons before every answer. The reasoning stays folded away; tap **Thinking for a better answer…** to read it. LFM3 Omni 2B, or a custom model whose template has no thinking mode, answers right away.
- **Three safety modes**: *Ask for Approval*, *Approve for Me* and *Full Auto*. Approve for Me needs the [Auto 150M](https://huggingface.co/ProCreations/auto-150m-3) classifier, which approves safe actions and asks you about the rest; picking it downloads Auto 150M first. Commands that could wipe data always ask.
- **Memory and For You**: it learns small facts about you, uses only the relevant ones (to keep prompts short) and suggests ideas based on them.
- **Routines** you can run with one click or on a schedule, and an **Activity** log of every action and who approved it.
- **One-click downloads** inside the app, with a choice of model size (Smaller, Balanced, Best, or any GGUF quant in Settings). The app still routes each message itself.

Everything stays on your computer. The only network traffic is the one-time downloads and web searches you ask for.

## Install

On a Mac, download the app and drag it to Applications:

- [Liquid Agent for Apple silicon](https://github.com/morriszdweck/liquid-agent/releases/latest/download/Liquid-Agent-arm64.dmg)
- [Liquid Agent for Intel](https://github.com/morriszdweck/liquid-agent/releases/latest/download/Liquid-Agent-x64.dmg)

The app isn't notarized yet, so macOS blocks it the first time. Either install with the Terminal command below instead, or open System Settings → Privacy & Security, scroll down and click **Open Anyway**. On first launch it installs Liquid Agent (the same copy the command below installs) and shows the setup screen.

Or paste this into Terminal on macOS, or a terminal on Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh | bash
```

It installs a ready-to-run copy in `~/.liquid-agent` (nothing else to install and no build step), adds **Liquid Agent** to your app menu on Linux and a `liquid-agent` command, then opens the setup screen at <http://127.0.0.1:8170> (in the Mac app when it's installed). Pick what to download and a model size there; that's it.

Afterwards, open it from Applications, Spotlight or your app menu, or with `liquid-agent`. The Mac app is a window onto that same copy (`crates/liquid-desktop`), so it updates along with it. `liquid-agent stop` stops it.

It keeps itself up to date: every push to `main` is published as a release, new versions download in the background and go in when nothing is running, and if one doesn't start the previous version comes back. Turn this off in Settings → General; `liquid-agent update` gets the newest version right away.

Requirements: an Apple silicon Mac with macOS 14 or later, or a 64-bit Linux computer (see [Linux](#linux)), and about 4 GB of free space for everything (1.1 GB for text chat only).

From a clone instead (it won't update itself; use `git pull`): install Rust, and Node.js 22 or newer to build the web UI (it isn't needed to run), then run `cargo build --release -p liquid-guardian -p liquid-server && npm ci && npm run build && npm start`.

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

**Not yet on Linux:** the Web helper's browser needs an x86_64 computer. The safety helper runs on the CPU.

## What gets downloaded

| Part | What it is | Size |
| --- | --- | --- |
| AI engine | [llama.cpp](https://github.com/ggml-org/llama.cpp) server, latest release | ~30 MB |
| Everyday brain | [LFM3 1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) (GGUF, QAD-Q4_0 to F16) | 1.05–3.5 GB |
| Eyes and ears | [LFM3 Omni 2B](https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF) (Q4_0 to F16) plus its audio and vision projector | 1.6–4 GB |
| Safety helper | Auto 150M, run by the Rust guardian | ~300 MB |
| Web helper | Chrome for Testing's headless shell | ~250 MB |

Files live in `~/Library/Application Support/LiquidAgent` on macOS and `~/.local/share/liquid-agent` on Linux. Settings → Downloads switches model sizes (the old size keeps answering until the new one is ready) and removes any part.

**Advanced: your own model.** Settings → Advanced → Everyday brain model → **Use a model from Hugging Face** takes a link such as `https://huggingface.co/<org>/<model>-GGUF`. Liquid Agent reads the repository's GGUF list, groups split files, picks a size that should fit this computer, checks the GGUF header and chat template, and runs it on the same llama.cpp engine. A `blob` link to one `.gguf` file preselects that file. Public repositories work directly; for a gated or private one, accept its terms on Hugging Face and set `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) before starting Liquid Agent. Only text GGUF models are used here; vision/audio projectors are skipped. Switch back to the built-in LFM3 1.7B at any time. A model you add hasn't been tested with Liquid Agent's tools, so while it answers, Full Auto works like Approve for Me and Auto 150M checks each action.

## How it works

```
browser ──HTTP/WebSocket──▶ crates/liquid-server (Rust, 127.0.0.1:8170)
                              ├─ llama-server  Everyday brain :8180  (LFM3 1.7B or your GGUF)
                              ├─ llama-server  LFM3 Omni 2B   :8181  (chat, ASR, TTS, realtime voice)
                              ├─ liquid-guardian Auto 150M     :8766
                              └─ Web helper   Chrome headless :8767 (the same server, in bridge mode)
```

- `crates/liquid-server/src/chat.rs` runs the agent loop. LFM3 writes tool calls in its native format; `crates/liquid-core/src/toolparser.rs` reads that and the other common forms.
- `crates/liquid-core/src/models.rs` and `gguf.rs` read Hugging Face links, find and group GGUF files, pick a size for this computer and check a model's header before it runs.
- `crates/liquid-server/src/voice.rs` bridges the browser microphone to Omni's realtime API and runs tools in the middle of a conversation.
- `crates/liquid-server/src/updater.rs` downloads and checks new builds; `crates/liquid-guardian/src/handover.rs` swaps the folders and rolls back if a new build doesn't start.
- `web/` is a React and TypeScript app built with Vite into `web/dist`, which the server hosts. `desktop/setup/` is the first-run screen of the Mac app, also TypeScript built with Vite; the Mac app inlines it.

The server only accepts requests from this computer, from its own page, carrying a token that changes every launch.

## Develop

The server is Rust (`crates/liquid-server`): it serves the web UI and its API, runs the agent, the models, voice, routines, reminders, self-updates and the Web helper, which drives a headless Chrome over the DevTools protocol (`crates/liquid-server/src/browser_bridge.rs`). `crates/liquid-guardian` is the `liquid-agent` command and the Auto 150M safety helper. `crates/liquid-desktop` is the Mac app's window. The web UI (`web/`) and the Mac app's setup screen (`desktop/setup/`) are TypeScript built with Vite.

```bash
cargo build --release -p liquid-guardian -p liquid-server
npm ci
npm run dev        # rebuilds the UI and runs the Rust server
npm run typecheck  # TypeScript for the web UI and the setup screen
cargo test --workspace   # Rust unit tests
npm run test:web  # client unit tests (Vitest), for the audio and text helpers
npm test           # starts the server and checks its API (needs the debug build above)
npm run test:server   # every backend test: the real server binaries with fake engines (tests/server)
node scripts/bundle.mjs --build 1   # packs release/liquid-agent.tar.gz and latest.json, as CI does for releases
npm run build:setup && scripts/mac-app.sh aarch64-apple-darwin arm64   # on a Mac: the Mac app and its DMG
```

Run the server on its own with `LIQUID_AGENT_RUST_HOME=/tmp/liquid-agent-test cargo run -p liquid-server` (port 8170 by default; `LIQUID_AGENT_PORT` changes it). Desktop tests that need a real session run with `cargo test -p liquid-server desktop_check -- --ignored --test-threads=1`.

## Languages

The interface and the models speak English, Español, Português, Français, Deutsch, Italiano, 中文 and 日本語. Settings → General → Language picks one, or follows the browser ("Auto"). With "Auto", the models answer in the language the user writes in.

- **The web UI** is translated in `web/src/i18n/locales/`, one file per language. `en.ts` is the source; every other file must have every key, and `npm run typecheck` fails if one is missing. Missing text falls back to English.
- **The models' prompts** are in `crates/liquid-core/src/i18n.rs`: the system prompt, the voice instructions, the tool framing, the starter routines, and the words the server shows for each action and approval. Tool names and their arguments stay in English, because they are the protocol the models answer in.
- **Server messages** (errors shown in the interface) are dictionary entries whose English text matches the server's, in `web/src/i18n/locales/*.ts` under `server.*`.

- **The terminal and log lines** (the launcher, the server's start-up lines, and the messages written to the log) are in the `Console` and `Diag` tables in the same file. Protocol output that other programs read, such as the guardian's JSON replies, stays in English.
- **Speech**: read-aloud and dictation go through LFM3 Omni 2B. Dictation asks for the words in the language that is spoken, without translating. Read-aloud makes each clip again, up to three times, until the model's own transcript of it matches the text; the closest clip is played.
- **Known limits**: the speech model sometimes drifts into English or garbles a loanword (for example "Downloads" in German, or "ダウンロード" in Japanese), and it can make factual errors in its answers. Translations have not had a native-speaker review yet; `node scripts/i18n-review.mjs > i18n-review.csv` lists every translated string for one.

To add a language: add its code to `CODES` and its table to `crates/liquid-core/src/i18n.rs` (the compiler lists any missing field), add `web/src/i18n/locales/<code>.ts`, and register it in `LOCALES` in `web/src/i18n/index.ts`.

## License

MIT
