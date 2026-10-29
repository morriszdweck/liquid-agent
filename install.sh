#!/bin/bash
# Installs Liquid Agent, or updates it. Run:
#
#   curl -fsSL https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh | bash
#
# Works on macOS and on Linux (x86_64 or arm64). The app goes in ~/.liquid-agent,
# with its own copy of Node.js if this computer has none new enough. It adds
# "Liquid Agent" to ~/Applications (macOS) or the app menu (Linux) and a
# `liquid-agent` command, then opens the setup screen in your browser. Models
# are downloaded from there.
set -euo pipefail

REPO="${LIQUID_AGENT_REPO:-morriszdweck/liquid-agent}"
BRANCH="${LIQUID_AGENT_BRANCH:-main}"
ROOT="${LIQUID_AGENT_HOME:-$HOME/.liquid-agent}"
NODE_VERSION="22.11.0"
PORT="${LIQUID_AGENT_PORT:-8170}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\033[36m→\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    DATA="$HOME/Library/Application Support/LiquidAgent"
    node_os="darwin"
    [ "$ARCH" = "arm64" ] || bold "Heads up: Liquid Agent is built for Apple silicon. It will be slow on this Mac."
    ;;
  Linux)
    DATA="${XDG_DATA_HOME:-$HOME/.local/share}/liquid-agent"
    node_os="linux"
    case "$ARCH" in
      x86_64 | aarch64 | arm64) ;;
      *) fail "Liquid Agent runs on 64-bit Intel, AMD or ARM computers. This one is $ARCH." ;;
    esac
    ;;
  *) fail "Liquid Agent runs on macOS and Linux." ;;
esac
command -v curl >/dev/null || fail "curl is missing."
command -v tar >/dev/null || fail "tar is missing."
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print $1 }'; }

bold "Installing Liquid Agent"
mkdir -p "$ROOT/bin" "$DATA/logs"

# ---- Node.js: use one that is new enough, or keep a private copy ----

find_node() {
  for candidate in "$ROOT/node/bin/node" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 22 ]; then
      echo "$candidate"
      return
    fi
  done
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  node_arch="arm64"
  [ "$ARCH" = "x86_64" ] && node_arch="x64"
  file="node-v$NODE_VERSION-$node_os-$node_arch.tar.gz"
  step "Getting Node.js $NODE_VERSION"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$file" -o "$tmp/$file"
  expected="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$file" '$2 == f { print $1 }')"
  actual="$(sha256 "$tmp/$file")"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "The Node.js download didn't match its checksum. Try again."
  rm -rf "$ROOT/node"
  mkdir -p "$ROOT/node"
  tar -xzf "$tmp/$file" -C "$ROOT/node" --strip-components 1
  rm -rf "$tmp"
  NODE="$ROOT/node/bin/node"
fi
export PATH="$(dirname "$NODE"):$PATH"
step "Using Node.js $("$NODE" -v)"

# ---- The app ----

# Stop a running copy first so its files can be replaced.
if curl -fs --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q liquid-agent; then
  step "Stopping the running Liquid Agent"
  pkill -f "$ROOT/app/server/index.js" 2>/dev/null || true
  sleep 2
fi

step "Downloading the app"
tmp="$(mktemp -d)"
if [ -n "${LIQUID_AGENT_SOURCE:-}" ]; then
  tar -xzf "$LIQUID_AGENT_SOURCE" -C "$tmp" # a local tarball, for testing
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$tmp"
fi
src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -f "$src/server/index.js" ] || fail "That download doesn't look like Liquid Agent."
rm -rf "$ROOT/app.old"
[ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"
mv "$src" "$ROOT/app"
rm -rf "$tmp" "$ROOT/app.old"

step "Installing its parts (about a minute)"
cd "$ROOT/app"
npm ci --no-audit --no-fund --loglevel=error >"$DATA/logs/install.log" 2>&1 || fail "Installing failed. Details: $DATA/logs/install.log"
step "Building the app"
npm run build --silent >>"$DATA/logs/install.log" 2>&1 || fail "Building failed. Details: $DATA/logs/install.log"
npm prune --omit=dev --no-audit --no-fund --loglevel=error >>"$DATA/logs/install.log" 2>&1 || true

# ---- Ways to open it ----

cat >"$ROOT/bin/liquid-agent" <<EOF
#!/bin/bash
# Opens Liquid Agent, starting it in the background if needed.
#   liquid-agent          open it
#   liquid-agent stop     stop it and its models
#   liquid-agent update   get the newest version
#   liquid-agent logs     show what it printed
ROOT="$ROOT"
DATA="$DATA"
PORT="$PORT"
export PATH="$(dirname "$NODE"):\$PATH"
running() { curl -fs --max-time 2 "http://127.0.0.1:\$PORT/healthz" 2>/dev/null | grep -q liquid-agent; }
show() {
  if [ "\$(uname -s)" = Darwin ]; then
    open "\$1"
  elif [ -n "\${DISPLAY:-}\${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null; then
    (xdg-open "\$1" >/dev/null 2>&1 &)
  else
    echo "Open \$1 in your browser." # no desktop here, e.g. over SSH
  fi
}
case "\${1:-open}" in
  open)
    if running; then
      show "http://127.0.0.1:\$PORT"
    else
      echo "Starting Liquid Agent at http://127.0.0.1:\$PORT"
      mkdir -p "\$DATA/logs"
      nohup "$NODE" "\$ROOT/app/server/index.js" --open </dev/null >>"\$DATA/logs/server.log" 2>&1 &
    fi
    ;;
  stop) pkill -f "\$ROOT/app/server/index.js" && echo "Stopped." || echo "It wasn't running." ;;
  update) curl -fsSL "https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh" | bash ;;
  logs) tail -n 80 "\$DATA/logs/server.log" ;;
  *) echo "Use: liquid-agent [open|stop|update|logs]" ;;
esac
EOF
chmod +x "$ROOT/bin/liquid-agent"

mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/liquid-agent" "$HOME/.local/bin/liquid-agent"

if [ "$OS" = "Darwin" ]; then
  # A small app for Launchpad, Spotlight and the Dock.
  APP="$HOME/Applications/Liquid Agent.app"
  mkdir -p "$HOME/Applications"
  rm -rf "$APP"
  osacompile -o "$APP" -e "do shell script quoted form of \"$ROOT/bin/liquid-agent\"" >/dev/null 2>&1 || true
  if [ -d "$APP" ]; then
    # Give it the Liquid Agent icon; a plain one is fine if this doesn't work.
    osascript -l JavaScript -e "ObjC.import('AppKit'); const img = \$.NSImage.alloc.initWithContentsOfFile('$ROOT/app/web/public/icon.svg'); if (img && img.isValid) \$.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, '$APP', 0);" >/dev/null 2>&1 || true
  fi
  WHERE="Applications or Spotlight"
else
  # An entry in the app menu.
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$APPS"
  cat >"$APPS/liquid-agent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Liquid Agent
Comment=A private AI agent that runs on this computer
Exec="$ROOT/bin/liquid-agent"
Icon=$ROOT/app/web/public/icon.svg
Terminal=false
Categories=Utility;
EOF
  if command -v update-desktop-database >/dev/null; then update-desktop-database "$APPS" >/dev/null 2>&1 || true; fi
  WHERE="your app menu"
fi

bold "Liquid Agent is installed."
echo "Open it any time from $WHERE (\"Liquid Agent\"), or run: liquid-agent"
if [ "$OS" = "Linux" ]; then
  # Everything works without these; they add the clipboard, audio files and reminder pop-ups.
  if command -v apt-get >/dev/null; then pm="sudo apt install" ffmpeg="ffmpeg" notify="libnotify-bin"
  elif command -v dnf >/dev/null; then pm="sudo dnf install" ffmpeg="ffmpeg-free" notify="libnotify"
  elif command -v pacman >/dev/null; then pm="sudo pacman -S" ffmpeg="ffmpeg" notify="libnotify"
  elif command -v zypper >/dev/null; then pm="sudo zypper install" ffmpeg="ffmpeg" notify="libnotify-tools"
  else pm="" ffmpeg="ffmpeg" notify="notify-send"
  fi
  want=""
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    command -v wl-copy >/dev/null || want="$want wl-clipboard"
  else
    command -v xclip >/dev/null || command -v xsel >/dev/null || want="$want xclip"
  fi
  command -v ffmpeg >/dev/null || want="$want $ffmpeg"
  command -v notify-send >/dev/null || want="$want $notify"
  if [ -n "$want" ]; then
    if [ -n "$pm" ]; then echo "Optional extras for the clipboard, audio files and reminders: $pm$want"
    else echo "Optional extras for the clipboard, audio files and reminders:$want"; fi
  fi
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "(To use the liquid-agent command, add ~/.local/bin to your PATH.)" ;;
esac

step "Opening the setup screen"
"$ROOT/bin/liquid-agent" open
