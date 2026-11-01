#!/bin/bash
# Installs Liquid Agent, or updates it. Run:
#
#   curl -fsSL https://raw.githubusercontent.com/morriszdweck/liquid-agent/main/install.sh | bash
#
# Works on macOS and on Linux (x86_64 or arm64). The app goes in ~/.liquid-agent.
# It is all Rust (the server, the launcher and the Web helper's browser control), so
# nothing else needs installing, and it keeps itself up to date after this.
# It adds "Liquid Agent" to the app menu (Linux; on macOS the Mac app opens it) and a
# `liquid-agent` command, then opens the setup screen. Models are downloaded from there.
set -euo pipefail

REPO="${LIQUID_AGENT_REPO:-morriszdweck/liquid-agent}"
BRANCH="${LIQUID_AGENT_BRANCH:-main}"
ROOT="${LIQUID_AGENT_HOME:-$HOME/.liquid-agent}"
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
    [ "$ARCH" = "arm64" ] || bold "Heads up: Liquid Agent is built for Apple silicon. It will be slow on this Mac."
    ;;
  Linux)
    DATA="${XDG_DATA_HOME:-$HOME/.local/share}/liquid-agent"
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

# ---- The app ----

# Stop a running copy first so its files can be replaced.
if curl -fs --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q liquid-agent; then
  step "Stopping the running Liquid Agent"
  pkill -f "$ROOT/app/bin/liquid-server-" 2>/dev/null || true
  sleep 2
fi

step "Downloading the app"
tmp="$(mktemp -d)"
if [ -n "${LIQUID_AGENT_BUNDLE:-}" ]; then
  cp "$LIQUID_AGENT_BUNDLE" "$tmp/app.tar.gz" # a local bundle, for testing
else
  # Every push to main publishes a ready-to-run bundle, so nothing is built here.
  curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json" -o "$tmp/latest.json" ||
    fail "Couldn't reach GitHub to download Liquid Agent. Check your connection and try again."
  # latest.json is written by scripts/bundle.mjs: one "key": "value" pair per line.
  json_value() { grep -o "\"$1\": *\"[^\"]*\"" "$2" | head -1 | sed 's/.*: *"\([^"]*\)"$/\1/'; }
  url="$(json_value url "$tmp/latest.json")"
  expected="$(json_value sha256 "$tmp/latest.json")"
  [ -n "$url" ] && [ -n "$expected" ] || fail "The update feed doesn't look like Liquid Agent's."
  curl -fsSL "$url" -o "$tmp/app.tar.gz" || fail "The download didn't finish. Try again."
  [ "$(sha256 "$tmp/app.tar.gz")" = "$expected" ] || fail "The download didn't match its checksum. Try again."
fi
tar -xzf "$tmp/app.tar.gz" -C "$tmp"
case "$OS-$ARCH" in
  Linux-x86_64) native="linux-x64" ;;
  Linux-aarch64|Linux-arm64) native="linux-arm64" ;;
  Darwin-arm64) native="darwin-arm64" ;;
  Darwin-x86_64) native="darwin-x64" ;;
  *) fail "No launcher is available for $OS $ARCH." ;;
esac
[ -f "$tmp/liquid-agent/build.json" ] || fail "That download doesn't look like Liquid Agent."
[ -f "$tmp/liquid-agent/bin/liquid-server-$native" ] || fail "This bundle does not contain a server for $native."
[ -f "$tmp/liquid-agent/bin/liquid-guardian-$native" ] || fail "This bundle does not contain a launcher for $native."
rm -rf "$ROOT/app.old" "$ROOT/app.next" "$ROOT/app.download" "$ROOT/app.bad"
[ -d "$ROOT/app" ] && mv "$ROOT/app" "$ROOT/app.old"
mv "$tmp/liquid-agent" "$ROOT/app"
rm -rf "$tmp" "$ROOT/app.old"

# ---- Ways to open it ----

# The release bundle includes a Rust launcher and server for each supported platform.
cp "$ROOT/app/bin/liquid-guardian-$native" "$ROOT/bin/liquid-agent.new"
chmod +x "$ROOT/bin/liquid-agent.new"
mv -f "$ROOT/bin/liquid-agent.new" "$ROOT/bin/liquid-agent"
# The launcher reads these settings; quotes and backslashes in the paths are escaped.
json_string() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
printf '{"root":"%s","data":"%s","port":"%s","repo":"%s","branch":"%s"}\n' \
  "$(json_string "$ROOT")" "$(json_string "$DATA")" "$PORT" "$(json_string "$REPO")" "$(json_string "$BRANCH")" >"$ROOT/bin/launcher.json"

mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/liquid-agent" "$HOME/.local/bin/liquid-agent"

if [ "$OS" = "Darwin" ]; then
  # The Liquid Agent Mac app (a DMG on the website) is the way to open it on a Mac.
  # Older installs made a small app in ~/Applications that only opened a browser tab: remove it.
  old="$HOME/Applications/Liquid Agent.app"
  if [ -d "$old" ] && [ ! -e "$old/Contents/MacOS/Liquid Agent" ]; then rm -rf "$old"; fi
  if [ -e "/Applications/Liquid Agent.app/Contents/MacOS/Liquid Agent" ]; then WHERE="Applications or Spotlight"
  else WHERE="the Mac app (get it at liquid-agent.mincoffical.codes)"; fi
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
Icon=$ROOT/app/web/dist/icon.svg
Terminal=false
Categories=Utility;
EOF
  if command -v update-desktop-database >/dev/null; then update-desktop-database "$APPS" >/dev/null 2>&1 || true; fi
  WHERE="your app menu"
fi

bold "Liquid Agent is installed."
echo "Open \"Liquid Agent\" any time from $WHERE, or run: liquid-agent"
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

# The Mac app runs this installer itself and opens Liquid Agent when it's done.
if [ -z "${LIQUID_AGENT_NO_OPEN:-}" ]; then
  step "Opening the setup screen"
  "$ROOT/bin/liquid-agent" open
fi
