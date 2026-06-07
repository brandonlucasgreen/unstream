#!/usr/bin/env bash
#
# Upload api/ source maps to Sentry.
#
# Idempotent on env var presence: if SENTRY_AUTH_TOKEN is not set, this script
# exits 0 with a log line instead of crashing the build. This makes the script
# safe to wire into Netlify's build command even before the Sentry env vars are
# configured (e.g., on PR deploy previews).
#
# Required env vars (only when uploading):
#   SENTRY_AUTH_TOKEN — auth token with `project:releases` and `org:read` scopes
#   SENTRY_ORG        — Sentry organization slug
#   SENTRY_PROJECT    — Sentry project slug
#   SENTRY_RELEASE    — release name (used by both upload and api/lib/sentry.ts)
#
# See api/.env.example for documentation.

set -euo pipefail

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "[sentry-sourcemaps] SENTRY_AUTH_TOKEN not set, skipping source map upload."
  echo "[sentry-sourcemaps] To enable, set SENTRY_AUTH_TOKEN (and SENTRY_ORG, SENTRY_PROJECT, SENTRY_RELEASE) in Netlify env."
  exit 0
fi

if [ -z "${SENTRY_ORG:-}" ] || [ -z "${SENTRY_PROJECT:-}" ] || [ -z "${SENTRY_RELEASE:-}" ]; then
  echo "[sentry-sourcemaps] ERROR: SENTRY_AUTH_TOKEN is set but one of SENTRY_ORG / SENTRY_PROJECT / SENTRY_RELEASE is missing." >&2
  echo "[sentry-sourcemaps] Aborting to avoid uploading source maps with incomplete metadata." >&2
  exit 1
fi

# Resolve repo root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/api/functions"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "[sentry-sourcemaps] No source directory at $SOURCE_DIR, nothing to upload."
  exit 0
fi

echo "[sentry-sourcemaps] Uploading source maps for $SOURCE_DIR"
echo "[sentry-sourcemaps] Org: $SENTRY_ORG  Project: $SENTRY_PROJECT  Release: $SENTRY_RELEASE"

# npx --yes avoids requiring a permanent install of @sentry/cli.
# set +e so we capture the exit code for a clearer log line on failure.
set +e
npx --yes @sentry/cli@latest sourcemaps upload \
  --org="$SENTRY_ORG" \
  --project="$SENTRY_PROJECT" \
  --auth-token="$SENTRY_AUTH_TOKEN" \
  --release="$SENTRY_RELEASE" \
  "$SOURCE_DIR"
EXIT=$?
set -e

if [ $EXIT -ne 0 ]; then
  echo "[sentry-sourcemaps] Upload failed with exit code $EXIT. Check the Sentry auth token and release name." >&2
  exit $EXIT
fi

echo "[sentry-sourcemaps] Upload complete."
