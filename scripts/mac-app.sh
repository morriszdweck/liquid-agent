#!/bin/bash
# Builds the Liquid Agent Mac app for one architecture, from the Rust window in
# crates/liquid-desktop, and packs it in a DMG. Run on a Mac, after `npm run build:setup`:
#
#   scripts/mac-app.sh aarch64-apple-darwin arm64
#   scripts/mac-app.sh x86_64-apple-darwin x64
#
# Writes desktop/dist/mac-<arch>/Liquid Agent.app and desktop/dist/Liquid-Agent-<arch>.dmg.
set -euo pipefail

TARGET="${1:?usage: mac-app.sh TARGET ARCH}"
ARCH="${2:?usage: mac-app.sh TARGET ARCH}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/desktop/dist"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/crates/liquid-desktop/Cargo.toml" | head -1)"
APP="$OUT/mac-$ARCH/Liquid Agent.app"

[ "$(uname -s)" = "Darwin" ] || { echo "The Mac app is built on a Mac." >&2; exit 1; }
[ -f "$ROOT/desktop/setup-dist/index.html" ] || { echo "Run npm run build:setup first." >&2; exit 1; }

cargo build --release --locked --manifest-path "$ROOT/crates/liquid-desktop/Cargo.toml" --target "$TARGET"

rm -rf "$OUT/mac-$ARCH"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/crates/liquid-desktop/target/$TARGET/release/liquid-desktop" "$APP/Contents/MacOS/Liquid Agent"
chmod +x "$APP/Contents/MacOS/Liquid Agent"

# The icon: every size an .icns needs, from the app's PNG.
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/desktop/build/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$ROOT/desktop/build/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Liquid Agent</string>
  <key>CFBundleExecutable</key><string>Liquid Agent</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>codes.mincoffical.liquidagent</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Liquid Agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Liquid Agent listens when you talk to it in voice chat or dictate a message.</string>
  <key>NSCameraUsageDescription</key><string>Liquid Agent looks through the camera only when you turn it on in voice chat.</string>
  <key>NSAppleEventsUsageDescription</key><string>Liquid Agent can control other apps when you ask it to.</string>
</dict>
</plist>
PLIST

# Ad hoc signature, as before: the app is not notarized.
codesign --force --sign - "$APP"

# The DMG: the app, and a link to Applications to drag it onto.
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT/Liquid-Agent-$ARCH.dmg"
hdiutil create -volname "Liquid Agent" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Liquid-Agent-$ARCH.dmg" >/dev/null
rm -rf "$STAGE" "$(dirname "$ICONSET")"
echo "Built $APP and $OUT/Liquid-Agent-$ARCH.dmg"
