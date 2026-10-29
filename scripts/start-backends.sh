#!/usr/bin/env bash
# Starts every local backend Liquid Agent uses. All bind to 127.0.0.1.
#   :8180  LFM3 1.7B      (llama-server)
#   :8181  LFM3 Omni 2B   (llama-server + vision projector)
#   :8766  Auto 200M guardian
#   :8767  Betterwright bridge
# Override model repos with env vars, e.g. LA_SMALL_GGUF=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M (dev only; the app downloads models itself)
set -euo pipefail
cd "$(dirname "$0")/.."

SMALL="${LA_SMALL_GGUF:-LiquidAI/LFM3-1.7B-GGUF:Q4_K_M}"
OMNI="${LA_OMNI_GGUF:-LiquidAI/LFM3-Omni-2B-GGUF:Q4_K_M}"
CTX="${LA_CTX:-8192}"
LOGS="${TMPDIR:-/tmp}/liquid-agent"
mkdir -p "$LOGS"
pids=()

cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

start() { # name, log, command...
  local name=$1 log=$2; shift 2
  echo "starting $name (log: $LOGS/$log)"
  "$@" >"$LOGS/$log" 2>&1 &
  pids+=($!)
}

# Prefer the app's own llama.cpp: older Homebrew builds can't load the lfm3 architecture.
LLAMA="$(find "$HOME/Library/Application Support/LiquidAgent/engine" -name llama-server -type f 2>/dev/null | head -1)"
LLAMA="${LLAMA:-$(command -v llama-server || true)}"
if [ -n "$LLAMA" ]; then
  start "LFM3 1.7B" small.log "$LLAMA" -hf "$SMALL" --host 127.0.0.1 --port 8180 -c "$CTX" --jinja --alias LFM3-1.7B
  start "LFM3 Omni 2B" omni.log "$LLAMA" -hf "$OMNI" --host 127.0.0.1 --port 8181 -c "$CTX" --jinja --alias LFM3-Omni-2B
else
  echo "llama-server not found: open the app and download the AI engine (Setup)"
fi

if [ ! -d guardian/.venv ]; then
  python3 -m venv guardian/.venv
  guardian/.venv/bin/pip install -q -r guardian/requirements.txt
fi
start "Auto 200M guardian" guardian.log guardian/.venv/bin/python -I guardian/server.py

if command -v node >/dev/null; then
  if [ ! -d bridge/node_modules ]; then
    (cd bridge && npm install --silent && npx betterwright setup)
  fi
  start "Betterwright bridge" bridge.log node bridge/server.mjs
else
  echo "node not found: browser tools disabled"
fi

echo "All backends started. Ctrl-C to stop."
wait
