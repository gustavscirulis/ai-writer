#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_REPO="gustavscirulis/ai-writer"
TAURI_CONF="$ROOT_DIR/apps/desktop/src-tauri/tauri.conf.json"

NOTARY_PROFILE="${WRITER_NOTARY_PROFILE:-writer-notary}"
export TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/writer-updater.key}"

usage() {
  echo "Usage: $0 [--notes-file <path>]"
  echo "Without --notes-file, the latest section of CHANGELOG.md becomes the release notes."
}

NOTES_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes-file)
      NOTES_FILE="$2"
      shift 2
      ;;
    --notes-file=*)
      NOTES_FILE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [ -z "$NOTES_FILE" ]; then
  NOTES_FILE="$(mktemp -t writer-release-notes)"
  awk '/^## /{n++; if (n == 2) exit; next} n == 1' "$ROOT_DIR/CHANGELOG.md" >"$NOTES_FILE"
fi
if [ ! -s "$NOTES_FILE" ] || ! grep -q '[^[:space:]]' "$NOTES_FILE"; then
  echo "Error: release notes are empty: $NOTES_FILE"
  exit 1
fi

CURRENT_BRANCH=$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "master" ]; then
  echo "Error: releases must be cut from master, currently on '$CURRENT_BRANCH'"
  exit 1
fi

if ! git -C "$ROOT_DIR" diff-index --quiet HEAD --; then
  echo "Error: working tree has uncommitted changes — commit the version bump first"
  git -C "$ROOT_DIR" status --short
  exit 1
fi

# --- Signing pre-flight: fail before the long build, not after it. ---

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  IDENTITIES=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | sort -u | tr -d '"' || true)
  IDENTITY_COUNT=$(printf '%s' "$IDENTITIES" | grep -c . || true)
  if [ "$IDENTITY_COUNT" -eq 0 ]; then
    echo "Error: no 'Developer ID Application' signing identity found in the keychain."
    exit 1
  fi
  if [ "$IDENTITY_COUNT" -gt 1 ]; then
    echo "Error: several Developer ID identities found; pick one with APPLE_SIGNING_IDENTITY=..."
    echo "$IDENTITIES"
    exit 1
  fi
  APPLE_SIGNING_IDENTITY="$IDENTITIES"
fi
export APPLE_SIGNING_IDENTITY
echo "Signing as: $APPLE_SIGNING_IDENTITY"

if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  echo "Error: notary keychain profile '$NOTARY_PROFILE' is missing or invalid. Create it once with:"
  echo "  xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <apple-id> --team-id <TEAMID>"
  exit 1
fi

if [ ! -f "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  echo "Error: updater signing key not found at $TAURI_SIGNING_PRIVATE_KEY"
  echo "Generate it once with: (cd apps/desktop && vp exec tauri signer generate -w ~/.tauri/writer-updater.key)"
  exit 1
fi

# An update signed with a key that doesn't match the shipped pubkey is rejected
# by every installed copy, so a mismatch has to stop the release here.
CONF_PUBKEY=$(python3 -c "import json; print(json.load(open('$TAURI_CONF'))['plugins']['updater']['pubkey'])")
if [ -f "$TAURI_SIGNING_PRIVATE_KEY.pub" ] && [ "$(tr -d '[:space:]' <"$TAURI_SIGNING_PRIVATE_KEY.pub")" != "$CONF_PUBKEY" ]; then
  echo "Error: $TAURI_SIGNING_PRIVATE_KEY.pub does not match plugins.updater.pubkey in tauri.conf.json"
  exit 1
fi
if ! grep -q "github.com/$RELEASE_REPO/releases" "$TAURI_CONF"; then
  echo "Error: the updater endpoint in tauri.conf.json does not point at $RELEASE_REPO"
  exit 1
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]; then
  read -rsp "Updater key password (Enter if none): " TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# Tauri notarizes on its own when these are set; notarization happens below
# through the keychain profile instead, so keep Tauri to signing only.
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

VERSION=$(python3 -c "import json; print(json.load(open('$TAURI_CONF'))['version'])")
TAG="v$VERSION"

# --- Git pre-flight: in sync with origin, tag unused. ---

echo "Fetching origin to verify sync..."
git -C "$ROOT_DIR" fetch origin master --tags

LOCAL_REV=$(git -C "$ROOT_DIR" rev-parse HEAD)
REMOTE_REV=$(git -C "$ROOT_DIR" rev-parse origin/master)
BASE_REV=$(git -C "$ROOT_DIR" merge-base HEAD origin/master)
if [ "$LOCAL_REV" != "$REMOTE_REV" ] && [ "$BASE_REV" != "$REMOTE_REV" ]; then
  echo "Error: local master is not a fast-forward of origin/master"
  echo "  local:  $LOCAL_REV"
  echo "  origin: $REMOTE_REV"
  echo "  Pull or rebase before releasing."
  exit 1
fi

if git -C "$ROOT_DIR" rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "Error: tag $TAG already exists locally — bump the version or delete the tag"
  exit 1
fi
if git -C "$ROOT_DIR" ls-remote --tags --exit-code origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists on origin — bump the version"
  exit 1
fi

echo "Pushing master to origin..."
git -C "$ROOT_DIR" push origin master

# --- Build and sign. ---

echo "Building Co-writer $TAG..."
cd "$ROOT_DIR/apps/desktop"
vp exec tauri build --bundles app,dmg

BUNDLE_DIR="$ROOT_DIR/apps/desktop/src-tauri/target/release/bundle"
DMG_DIR="$BUNDLE_DIR/dmg"
MACOS_DIR="$BUNDLE_DIR/macos"

DMG_FILE=$(ls "$DMG_DIR"/*"_${VERSION}_"*.dmg 2>/dev/null | head -1 || true)
APP_FILE="$MACOS_DIR/Co-writer.app"
TAR_FILE=$(ls "$MACOS_DIR"/*.app.tar.gz 2>/dev/null | head -1 || true)
SIG_FILE=$(ls "$MACOS_DIR"/*.app.tar.gz.sig 2>/dev/null | head -1 || true)

if [ -z "$DMG_FILE" ]; then
  echo "Error: No DMG for $VERSION found in $DMG_DIR"
  exit 1
fi
if [ -z "$TAR_FILE" ] || [ -z "$SIG_FILE" ]; then
  echo "Error: Updater artifacts missing in $MACOS_DIR"
  echo "  Expected: *.app.tar.gz and *.app.tar.gz.sig"
  echo "  Check that \`createUpdaterArtifacts\` is true and TAURI_SIGNING_PRIVATE_KEY is valid."
  exit 1
fi

codesign --verify --deep --strict "$APP_FILE"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG_FILE"

# --- Notarize and staple. Notarizing the DMG covers the app inside it. ---

echo "Submitting $(basename "$DMG_FILE") for notarization (this can take several minutes)..."
NOTARY_JSON=$(xcrun notarytool submit "$DMG_FILE" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json)
NOTARY_STATUS=$(printf '%s' "$NOTARY_JSON" | python3 -c "import json, sys; print(json.load(sys.stdin).get('status', ''))")
NOTARY_ID=$(printf '%s' "$NOTARY_JSON" | python3 -c "import json, sys; print(json.load(sys.stdin).get('id', ''))")
if [ "$NOTARY_STATUS" != "Accepted" ]; then
  echo "Error: notarization returned '$NOTARY_STATUS' (submission $NOTARY_ID). Apple's log:"
  xcrun notarytool log "$NOTARY_ID" --keychain-profile "$NOTARY_PROFILE" || true
  exit 1
fi

xcrun stapler staple "$DMG_FILE"
spctl --assess --type open --context context:primary-signature --verbose "$DMG_FILE"

echo ""
echo "Built: $(basename "$DMG_FILE") ($(du -h "$DMG_FILE" | cut -f1))"
echo "Built: $(basename "$TAR_FILE") ($(du -h "$TAR_FILE" | cut -f1))"

# --- Updater manifest. ---

HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in
  arm64|aarch64) TARGET="darwin-aarch64" ;;
  x86_64) TARGET="darwin-x86_64" ;;
  *) echo "Error: unsupported host architecture $HOST_ARCH"; exit 1 ;;
esac

SIGNATURE=$(cat "$SIG_FILE")
TAR_NAME=$(basename "$TAR_FILE")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NOTES="Co-writer $TAG"
DOWNLOAD_URL="https://github.com/$RELEASE_REPO/releases/download/$TAG/$TAR_NAME"

LATEST_JSON="$BUNDLE_DIR/latest.json"
python3 - "$LATEST_JSON" "$VERSION" "$NOTES" "$PUB_DATE" "$TARGET" "$SIGNATURE" "$DOWNLOAD_URL" <<'PY'
import json, sys
out_path, version, notes, pub_date, target, signature, url = sys.argv[1:]
payload = {
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    "platforms": {
        target: {
            "signature": signature,
            "url": url,
        }
    },
}
with open(out_path, "w") as f:
    json.dump(payload, f, indent=2)
PY

echo "Built: latest.json ($TARGET)"

# --- Draft release + tag. ---

echo ""
echo "Creating draft release $TAG on $RELEASE_REPO..."

gh release create "$TAG" "$DMG_FILE" "$TAR_FILE" "$LATEST_JSON" \
  --repo "$RELEASE_REPO" \
  --title "Co-writer $TAG" \
  --notes-file "$NOTES_FILE" \
  --draft

DRAFT_URL=$(gh release view "$TAG" --repo "$RELEASE_REPO" --json url --jq '.url')

# If you abandon the draft, delete this tag manually.
echo ""
echo "Tagging $TAG locally and pushing to origin..."
git -C "$ROOT_DIR" tag "$TAG"
git -C "$ROOT_DIR" push origin "$TAG"

echo ""
echo "Notarized DMG: $DMG_FILE"
echo "Draft created: $DRAFT_URL"
echo "Review the notes and click Publish to ship it."
