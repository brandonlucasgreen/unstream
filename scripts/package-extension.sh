#!/usr/bin/env bash
# Package the browser extension for the Chrome Web Store and Firefox AMO.
#
# There is no build step — the extension ships the source files as they are — so this is
# really two jobs: validate, then zip. The validation is the point. Two things have gone
# wrong here before and neither is visible until a store rejects the upload or, worse,
# accepts a broken one:
#
#   1. The two manifests are separate files that must agree on the version. manifest.json is
#      Chrome's; manifest-firefox.json is Firefox's, and it differs in more than the version
#      (browser_specific_settings, and background.scripts + "type": "module" where Chrome uses
#      background.service_worker). Bump one and forget the other and the stores disagree about
#      what 2.7.x means.
#   2. Every file a manifest names has to actually be in the zip. A typo'd content script path
#      fails silently at runtime on the store build.
#
# Each zip gets exactly one manifest, named manifest.json, at its root — Firefox's is renamed
# on the way in. Output lands in dist/extension/, which is gitignored.
#
# Usage: bash scripts/package-extension.sh

set -euo pipefail

SRC="apps/extension"
OUT="dist/extension"

command -v zip >/dev/null || { echo "error: zip is not installed" >&2; exit 1; }
[ -d "$SRC" ] || { echo "error: run this from the repo root" >&2; exit 1; }

chrome_version=$(python3 -c "import json;print(json.load(open('$SRC/manifest.json'))['version'])")
firefox_version=$(python3 -c "import json;print(json.load(open('$SRC/manifest-firefox.json'))['version'])")

if [ "$chrome_version" != "$firefox_version" ]; then
  echo "error: manifest versions disagree — chrome $chrome_version, firefox $firefox_version" >&2
  exit 1
fi

# Every path either manifest references must exist. Checked against both manifests so a file
# used only by Firefox (or only by Chrome) can't go missing from its own package.
python3 - "$SRC" <<'PYEOF'
import json, os, sys

src = sys.argv[1]
missing = []

for manifest in ('manifest.json', 'manifest-firefox.json'):
    data = json.load(open(os.path.join(src, manifest)))
    paths = set()

    for size_map in (data.get('icons'), data.get('action', {}).get('default_icon')):
        if size_map:
            paths.update(size_map.values())

    popup = data.get('action', {}).get('default_popup')
    if popup:
        paths.add(popup)

    background = data.get('background', {})
    if 'service_worker' in background:
        paths.add(background['service_worker'])
    paths.update(background.get('scripts', []))

    for entry in data.get('content_scripts', []):
        paths.update(entry.get('js', []))
        paths.update(entry.get('css', []))

    for path in sorted(paths):
        if not os.path.isfile(os.path.join(src, path)):
            missing.append(f'{manifest}: {path}')

if missing:
    print('error: manifest references files that do not exist:', file=sys.stderr)
    for entry in missing:
        print(f'  {entry}', file=sys.stderr)
    sys.exit(1)

print('manifest file references OK')
PYEOF

# Syntax-check every script before it ships. node --check parses as CommonJS, which rejects
# `import`/`export`, so ES modules are checked as modules instead.
for js in $(find "$SRC" -name '*.js' | sort); do
  if grep -qE '^\s*(import|export)\s' "$js"; then
    node --input-type=module --check < "$js" 2>/dev/null \
      || { echo "error: syntax error in $js" >&2; exit 1; }
  else
    node --check "$js" >/dev/null || { echo "error: syntax error in $js" >&2; exit 1; }
  fi
done
echo "javascript syntax OK"

rm -rf "$OUT"
mkdir -p "$OUT"

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# Chrome: everything but the Firefox manifest.
rm -rf "$staging/chrome" && cp -R "$SRC" "$staging/chrome"
rm -f "$staging/chrome/manifest-firefox.json"
(cd "$staging/chrome" && zip -qr -X "$OLDPWD/$OUT/unstream-chrome-$chrome_version.zip" .)

# Firefox: everything but Chrome's manifest, with its own renamed into place.
rm -rf "$staging/firefox" && cp -R "$SRC" "$staging/firefox"
mv "$staging/firefox/manifest-firefox.json" "$staging/firefox/manifest.json"
(cd "$staging/firefox" && zip -qr -X "$OLDPWD/$OUT/unstream-firefox-$firefox_version.zip" .)

echo
echo "Packaged version $chrome_version:"
ls -lh "$OUT" | tail -n +2 | awk '{printf "  %-44s %s\n", $9, $5}'
