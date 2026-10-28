#!/usr/bin/env bash
# Starts every local backend Liquid Agent uses. All bind to 127.0.0.1.
#   :8080  LFM3 1.7B      (llama-server)
#   :8081  LFM3 2B Omni   (llama-server, with vision projector if present)
#   :8766  Auto 200M guardian
#   :8767  Betterwright bridge
# Override model repos with env vars, e.g. LA_SMALL_GGUF=LiquidAI/LFM3-1.7B-GGUF:Q4_K_M
set -euo pipefail
cd "$(dirname "$0")/.."

SMALL="${LA_SMALL_GGUF:-LiquidAI/LFM3-1.7B-GGUF:Q4_K_M}"
OMNI="${LA_OMNI_GGUF:-LiquidAI/LFM3-2B-Omni-GGUF:Q4_K_M}"
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

if command -v llama-server >/dev/null; then
  start "LFM3 1.7B" small.log llama-server -hf "$SMALL" --host 127.0.0.1 --port 8080 -c "$CTX" --jinja --alias LFM3-1.7B
  start "LFM3 2B Omni" omni.log llama-server -hf "$OMNI" --host 127.0.0.1 --port 8081 -c "$CTX" --jinja --alias LFM3-2B-Omni
else
  echo "llama-server not found: brew install llama.cpp (or point Settings at Ollama / mlx_lm.server)"
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
