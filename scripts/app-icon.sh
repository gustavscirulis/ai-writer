#!/usr/bin/env bash
# Regenerates Assets.car and the png/icns/ico fallbacks from icons/icon.icon.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ICONS_DIR="$ROOT_DIR/apps/desktop/src-tauri/icons"
ICTOOL="/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# `--app-icon` has to match the document's file name.
cp -R "$ICONS_DIR/icon.icon" "$WORK_DIR/Icon.icon"
mkdir "$WORK_DIR/out"
# Run with stdin closed, actool fails with "Bad file descriptor" and leaves ibtoold failing every later call.
if ! xcrun actool "$WORK_DIR/Icon.icon" --compile "$WORK_DIR/out" \
  --output-format human-readable-text --notices --warnings \
  --output-partial-info-plist "$WORK_DIR/out/assetcatalog_generated_info.plist" \
  --app-icon Icon --include-all-app-icons \
  --enable-on-demand-resources NO --development-region en \
  --target-device mac --minimum-deployment-target 26.0 --platform macosx </dev/null; then
  echo "actool failed. If it reported \"Bad file descriptor\", run \`pkill -x ibtoold\` and try again." >&2
  exit 1
fi
cp "$WORK_DIR/out/Assets.car" "$ICONS_DIR/Assets.car"

"$ICTOOL" "$ICONS_DIR/icon.icon" --export-image --output-file "$WORK_DIR/icon-1024.png" \
  --platform macOS --rendition Default --width 1024 --height 1024 --scale 1
(cd "$ROOT_DIR/apps/desktop" && vp exec tauri icon "$WORK_DIR/icon-1024.png")
git -C "$ROOT_DIR" checkout -- apps/desktop/src-tauri/icons/android apps/desktop/src-tauri/icons/ios
