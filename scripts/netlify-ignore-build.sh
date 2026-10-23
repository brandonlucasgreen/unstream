#!/usr/bin/env bash
#
# Decides whether a push needs a production deploy.
#
# Netlify runs this as the `ignore` command (see netlify.toml). Its exit code is
# inverted from the usual shell convention, which is the one thing to keep in mind
# when editing this file:
#
#   exit 0  ->  CANCEL the build ("ignore this push")
#   exit 1  ->  RUN the build
#
# Every branch below therefore defaults to `exit 1`. If we cannot *prove* a push is
# irrelevant to the deployed site, we deploy it: a skipped deploy leaves production
# silently stale, which is far worse than a wasted build.
#
# Why this exists: a production deploy costs a flat 15 credits on Netlify's
# credit-based plans, and build minutes on the legacy plans. This repo holds four
# things Netlify never publishes — the Apple app, the browser extension, the database
# migrations, and the docs — so a Mac-app bugfix used to cost a full production
# deploy of the website.

set -uo pipefail

# Prefixes that cannot change what Netlify serves.
#
# Deliberately NOT in this list, because the build reads them:
#   data/       — copied wholesale into dist/ by the copy-data-to-dist plugin in
#                 apps/web/vite.config.ts, so every artist, guide and feed file counts
#   scripts/    — generates the manifests, feeds and sitemap during the build
#   api/        — functions and edge functions deploy straight from the repo
#   apps/web/   — the site itself
#   netlify.toml, package.json, package-lock.json
#
# docs/ is safe because the OpenAPI spec the site links to is a separate copy at
# apps/web/public/docs/openapi.yaml. If that ever becomes a build-time copy of
# docs/openapi.yaml, docs/ has to come out of this list.
IGNORED_PREFIXES=(
  "docs/"
  "apps/mac/"
  "apps/extension/"
  "supabase/"
  ".github/"
  "README.md"
  "CLAUDE.md"
)

if [ -z "${CACHED_COMMIT_REF:-}" ] || [ -z "${COMMIT_REF:-}" ]; then
  echo "No cached commit to compare against — building."
  exit 1
fi

if [ "$CACHED_COMMIT_REF" = "$COMMIT_REF" ]; then
  # A manual redeploy or a "clear cache and deploy" from the Netlify UI. There is no
  # diff to read, and whoever clicked the button wants a build.
  echo "Commit unchanged since the last build (manual redeploy) — building."
  exit 1
fi

if ! changed=$(git diff --name-only "$CACHED_COMMIT_REF" "$COMMIT_REF" 2>/dev/null); then
  echo "Could not diff $CACHED_COMMIT_REF..$COMMIT_REF — building."
  exit 1
fi

if [ -z "$changed" ]; then
  echo "No file changes detected — building."
  exit 1
fi

while IFS= read -r file; do
  ignorable=false
  for prefix in "${IGNORED_PREFIXES[@]}"; do
    case "$file" in
      "$prefix"*)
        ignorable=true
        break
        ;;
    esac
  done

  if [ "$ignorable" = false ]; then
    echo "$file can change the deployed site — building."
    exit 1
  fi
done <<< "$changed"

echo "Only non-deployed paths changed — skipping this build:"
echo "$changed" | sed 's/^/  /'
exit 0
