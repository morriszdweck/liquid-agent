#!/usr/bin/env bash
# Builds Liquid Agent.app (release, ad-hoc signed) into ./build.
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release
BIN="$(swift build -c release --show-bin-path)/LiquidAgent"
APP="build/Liquid Agent.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/LiquidAgent"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Liquid Agent</string>
  <key>CFBundleDisplayName</key><string>Liquid Agent</string>
  <key>CFBundleIdentifier</key><string>io.github.liquidagent.app</string>
  <key>CFBundleExecutable</key><string>LiquidAgent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Liquid Agent listens for voice chat. Audio stays on this Mac.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Liquid Agent transcribes your voice on-device.</string>
  <key>NSAppleEventsUsageDescription</key><string>Liquid Agent opens apps you ask it to.</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP"
echo "Built $APP"
