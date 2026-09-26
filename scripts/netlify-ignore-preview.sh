#!/usr/bin/env bash
#
# Decides whether a pull request gets a Deploy Preview.
#
# Netlify runs this as the deploy-preview `ignore` command (see netlify.toml). Same
# inverted exit code as netlify-ignore-build.sh:
#
#   exit 0  ->  CANCEL the build (no preview)
#   exit 1  ->  RUN the build
#
# Previews are off by default: they were ~280 of a 300-minute monthly allowance (#451),
# and a deploy costs a flat 15 credits on the credit plans. But some changes need a real
# URL — checking a page on a phone, sharing it with someone — so a preview is opt-in per
# push: put `[preview]` anywhere in the message of the commit at the head of the PR.
#
# Only the head commit counts. A later push without the marker is not previewed, which is
# the point: you pay for the pushes you want to look at, not for every push after the
# first one you did.
#
# A preview runs the real functions against PRODUCTION Supabase, exactly like `npm run dev`
# (CLAUDE.md, "Local dev"). Reads are free; writes are real.

set -uo pipefail

if [ -z "${COMMIT_REF:-}" ]; then
  echo "No COMMIT_REF — skipping the preview."
  exit 0
fi

if ! message=$(git log -1 --format=%B "$COMMIT_REF" 2>/dev/null); then
  echo "Could not read the commit message for $COMMIT_REF — skipping the preview."
  exit 0
fi

if printf '%s' "$message" | grep -qiF '[preview]'; then
  echo "Head commit asks for a preview — building."
  exit 1
fi

echo "No [preview] in the head commit message — skipping the preview (see scripts/netlify-ignore-preview.sh)."
exit 0
