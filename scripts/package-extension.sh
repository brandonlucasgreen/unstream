#!/usr/bin/env bash
# Build store-ready zips of the browser extension:
#   unstream-chrome-<version>.zip   → Chrome Web Store
#   unstream-firefox-<version>.zip  → addons.mozilla.org
#
# The extension has no build step, so each zip is apps/extension as-is with
# the right manifest at its root: Chrome ships manifest.json, Firefox ships
# manifest-firefox.json renamed to manifest.json. Neither zip carries the
# other browser's manifest.
#
# Both stores reject an upload whose version already exists, so bump
# "version" in BOTH manifests before running this. The script refuses to
# run if the two disagree.
#
# Usage: npm run package:extension [-- <output-dir>]   (default: dist/extension)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/extension"
OUT="$(mkdir -p "${1:-$ROOT/dist/extension}" && cd "${1:-$ROOT/dist/extension}" && pwd)"

read_version() {
  node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version)" "$1"
}

CHROME_VERSION="$(read_version "$SRC/manifest.json")"
FIREFOX_VERSION="$(read_version "$SRC/manifest-firefox.json")"
if [ "$CHROME_VERSION" != "$FIREFOX_VERSION" ]; then
  echo "Version mismatch: manifest.json is $CHROME_VERSION, manifest-firefox.json is $FIREFOX_VERSION" >&2
  exit 1
fi
VERSION="$CHROME_VERSION"

# Everything the extension loads; manifests are added per browser below.
CONTENTS=(background content fonts icons lib popup)

build_zip() {
  local browser="$1" manifest="$2"
  local stage zip
  stage="$(mktemp -d)"
  zip="$OUT/unstream-$browser-$VERSION.zip"

  cp -R "${CONTENTS[@]/#/$SRC/}" "$stage/"
  cp "$SRC/$manifest" "$stage/manifest.json"
  find "$stage" -name '.DS_Store' -delete

  rm -f "$zip"
  (cd "$stage" && zip -qr -X "$zip" .)
  rm -rf "$stage"
  echo "$zip"
}

build_zip chrome manifest.json
build_zip firefox manifest-firefox.json
