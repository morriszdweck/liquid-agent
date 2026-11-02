# Liquid Agent

A private AI agent for your Mac or Linux computer that runs **LFM3 1.7B** and **LFM3 Omni 2B** entirely on your computer, with a clean web interface in your browser.

- **Chat** with full Markdown: tables, code with highlighting and copy buttons, math, task lists.
- **Does things on your computer**: runs commands, reads and writes files, searches and reads the web, opens apps and links, sets reminders, uses the clipboard, and clicks around websites in a headless Chrome.
- **Voice chat** with LFM3 Omni 2B: it listens, thinks and talks back in one model. Talk over it to interrupt. Turn on the camera and it also sees what you show it.
- **Omni where it matters**: dictation, reading answers aloud, pictures, audio and your screen all go through LFM3 Omni 2B. Everyday text and documents go to the Everyday brain (LFM3 1.7B). The app picks the model for you.
- **Thinking display**: when a model emits reasoning, it is folded away in the chat. The app currently requests `enable_thinking: false`; behavior depends on the model template and engine version. LFM3 Omni 2B is a non-reasoning model.
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

**Speed.** On Linux the installer chooses a Vulkan build when `/dev/dri` exists or `LIQUID_AGENT_GPU=vulkan` is set; otherwise it chooses a CPU build. This is a heuristic and does not prove that a usable Vulkan device exists. `LIQUID_AGENT_GPU=cpu` requests CPU execution; reinstall the AI engine in Settings → Downloads to select the CPU build. CUDA builds are not currently selected by the installer, and `LIQUID_AGENT_GPU=cuda` does not enable CUDA. If a Vulkan or Metal model process exits or fails readiness during startup, the app retries once with CPU-only execution using the same engine binary. The engine must itself be able to start and include a CPU backend; missing loader dependencies and later runtime failures are not repaired by this retry. Inspect the model log under the data directory's `logs/` for details. New engine downloads are pinned to llama.cpp b12017; existing installations are not replaced automatically. This release documents Omni speech and realtime support, but model-backed verification remains necessary for each platform.

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

Files live in `~/Library/Application Support/LiquidAgent` on macOS and `~/.local/share/liquid-agent` on Linux. Settings → Downloads switches model sizes (the old model stays loaded while downloading and active model operations finish before replacement) and removes any part. Built-in models use a 16,384-token server context, one inference slot and a 256 MiB prompt-cache limit by default (the cache limit requires a compatible engine and is not preallocated memory); Settings → Advanced offers 8,192 or 32,768 tokens after a model restart. This server context includes prompt and output tokens and is distinct from the app’s prompt budget. The default automatic startup uses available Linux memory as a heuristic: below 6 GiB it prefers Omni and starts one large model; if unavailable it falls back to total memory. It is not a hard memory budget, and the decision may change between starts. Settings → Advanced → Model startup offers a hybrid option that starts the text model and loads Omni when needed. If CPU memory headroom is insufficient, or GPU headroom is unknown, it waits for active operations before switching and restores the text model after five idle minutes. This is an estimate, not a hard memory budget, and model reloads cause a warmup delay. It also offers an explicit single-Omni option that loads Omni on first use, or a dual option; explicit starts in Downloads can override it. In single-Omni mode, a manual stop suppresses automatic restart until a manual start or app restart, and a running text model is never evicted automatically. In automatic mode, a text-only installation can start the text model. The selection takes effect at the next app start or automatic installation and does not interrupt a running model. The safety helper starts automatically only when its approval mode needs it. The browser helper starts after an approved browser action and stays stopped if manually stopped until it is manually started or the app restarts. Settings → Advanced provides a Linux memory snapshot for the server and direct managed processes (PSS, RSS, private memory and swap); it excludes browser subprocesses and GPU memory. When supported, the engine also reports its build, context, slots and sleeping state. These properties do not verify speech or realtime capability. Realtime waits for a session update acknowledgment and reports unconfirmed configuration if an older engine does not acknowledge it; the acknowledgment verifies settings reported by the engine, not pronunciation. If the engine rejects session options, the bridge retries with language instructions alone and reports that realtime tools are unavailable; if that also fails, the call ends with an error. The separate opt-in Omni capability check generates a short Spanish WAV and attempts a realtime session handshake; it does not test accent, voice identity, vision or realtime audio. Setup uses currently available Linux memory for its size suggestion when available, but this is not a guarantee that a model will fit. Settings → Advanced also offers GPU-layer limits and an optional engine idle-sleep timer. Sleep reloads the model on demand and can cause a warmup delay; compatibility with live audio remains unverified. The Omni projector defaults to Q8; Settings → Advanced can select a smaller Q4 projector, but its speech and vision quality has not been compared.

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
- **Speech**: read-aloud and dictation go through LFM3 Omni 2B. Dictation has a separate language setting; its default asks for the words in the language spoken, without translating. An explicit selection uses a language-specific ASR instruction. Read-aloud has its own language and female/male voice settings; voice calls have a separate language setting that falls back to the general reply language and then automatic detection. Realtime uses an instruction, not a native output-language control; its model determines the accent, and the voice setting does not affect realtime voice. High quality runs ASR, the existing chat/tool pipeline and TTS sequentially; it passes the selected voice and call language to TTS. It takes longer to start speaking but works with one Omni slot. The ASR language can be set separately; auto follows the call language when explicitly selected. Automatic read-aloud language detection runs locally, using each sufficiently long clip or the full reply as context; it falls back to the engine default (usually English) when confidence is low or the language is unsupported. An engine-default option is also available. Optional read-aloud checking transcribes clips and retries up to three times when the words differ; it costs additional time and cannot judge accent.
- **Voice-call transcripts**: the realtime engine holds its only inference slot for the call, so microphone turns are transcribed after the call closes and saved to chat history. Up to 32 MiB of input audio per call is held in memory for this purpose; later turns beyond that limit remain labeled as voice messages. Transcription may also remain incomplete if the app exits before it finishes.
- **Camera during a voice call**: high-quality mode describes a captured frame between inference stages and works with one Omni slot. For realtime, select two Omni slots in Advanced settings and restart Omni. The realtime session occupies one slot and camera descriptions use the other; the configured context is shared between slots, so two slots halve the context available to each. The default one-slot mode keeps memory use lower and disables camera and media tools during calls. Image attachments and media tools remain available in regular chat.
- **Known limits**: the speech model sometimes drifts into English or garbles a loanword (for example "Downloads" in German, or "ダウンロード" in Japanese), and it can make factual errors in its answers. Translations have not had a native-speaker review yet; `node scripts/i18n-review.mjs > i18n-review.csv` lists every translated string for one.

To add a language: add its code to `CODES` and its table to `crates/liquid-core/src/i18n.rs` (the compiler lists any missing field), add `web/src/i18n/locales/<code>.ts`, and register it in `LOCALES` in `web/src/i18n/index.ts`.

## License

MIT

## Measuring resource use

In automatic mode, if the text model is running alone, an installed Omni can also start on demand for speech or vision. When estimated headroom is insufficient, the app waits for active model work before switching and restores text after the idle period, with the same warmup and estimation limitations as hybrid mode. On Linux, available-memory estimates also account for readable cgroup v2 limits on the process and its parent groups. These conservative limits can include reclaimable cache and do not account for GPU headroom.

To measure dictation separately, select the dictation language in Settings and run `node scripts/benchmark-models.mjs --mode asr --audio input.wav --turns 10 > asr-benchmark.json`. The report records response times and transcript lengths, not transcript text or recognition accuracy.

Use `--mode concurrent` to run a chat and a read-aloud request together on each turn. This exercises simultaneous inference and can use substantially more resources than sequential `--mode both`.

With the app already running and the desired models selected, run `node scripts/benchmark-models.mjs --mode both --turns 10 --lang es > benchmark.json`. Use `--help` for options and repeat with `--turns 100` and different model settings to compare runs. The script performs real inference and creates a temporary chat, deleting it afterwards unless `--keep-chat` is set. It reports median and p95 observed text and full-clip TTS latency, along with sampled server and direct-child PSS, available memory and swap. Sampling can miss peaks; PSS excludes browser subprocesses and GPU memory. The non-streaming read-aloud API does not expose time to first audio, and the script does not assess accent or speech quality. The opt-in `LIQUID_TEST_OMNI=1 npm test` smoke test sends explicit Spanish female and male requests to a real model and checks the WAV responses; it cannot judge pronunciation or voice identity. Record GPU measurements separately with the appropriate vendor tools.
