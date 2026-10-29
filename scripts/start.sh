#!/bin/bash
# Starts Liquid Agent and opens it in your browser.
# Finds Node.js (or downloads a private copy), installs and builds on first run.
set -euo pipefail

cd "$(dirname "$0")/.."
DATA="$HOME/Library/Application Support/LiquidAgent"
NODE_VERSION="22.11.0"

find_node() {
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$DATA/node/bin/node"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 20 ]; then
      echo "$candidate"
      return
    fi
  done
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  arch="$(uname -m)"
  [ "$arch" = "x86_64" ] && arch="x64"
  echo "Getting Node.js $NODE_VERSION (one time only)…"
  mkdir -p "$DATA/node"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$arch.tar.gz" | tar -xz -C "$DATA/node" --strip-components 1
  NODE="$DATA/node/bin/node"
fi
export PATH="$(dirname "$NODE"):$PATH"

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "Installing (one time only)…"
  npm ci --no-audit --no-fund --loglevel=error
  touch node_modules
fi

if [ ! -f web/dist/index.html ] || [ -n "$(find web/src web/public web/index.html -newer web/dist/index.html 2>/dev/null | head -1)" ]; then
  echo "Building the app…"
  npm run build --silent
fi

exec node server/index.js --open
