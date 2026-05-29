#!/bin/bash
# Test script for Unstream save/artist/profile endpoints
# Tests against production: https://unstream.stream

set -euo pipefail

BASE="https://unstream.stream"
PASS=0
FAIL=0

green() { echo -e "\033[32m✓ $1\033[0m"; }
red() { echo -e "\033[31m✗ $1\033[0m"; }
info() { echo -e "\033[36m→ $1\033[0m"; }
section() { echo -e "\n\033[1m$1\033[0m"; }

check() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    green "$desc"
    PASS=$((PASS+1))
  else
    red "$desc (expected: $expected, got: $actual)"
    FAIL=$((FAIL+1))
  fi
}

check_contains() {
  local desc="$1" actual="$2" expected="$3"
  if echo "$actual" | grep -q "$expected"; then
    green "$desc"
    PASS=$((PASS+1))
  else
    red "$desc (expected to contain: $expected)"
    FAIL=$((FAIL+1))
  fi
}

check_not_contains() {
  local desc="$1" actual="$2" unexpected="$3"
  if echo "$actual" | grep -q "$unexpected"; then
    red "$desc (unexpectedly contained: $unexpected)"
    FAIL=$((FAIL+1))
  else
    green "$desc"
    PASS=$((PASS+1))
  fi
}

# ============================================================
section "1. Artist Profile Pages (Edge Function SSR)"
# ============================================================

info "Testing /a/kid-lightbulbs — browser User-Agent"
RESP=$(curl -s "$BASE/a/kid-lightbulbs" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
check_contains "kid-lightbulbs page contains artist name" "$RESP" "Kid Lightbulbs"
check_contains "kid-lightbulbs page has OG tags" "$RESP" 'og:title'
check_not_contains "kid-lightbulbs page is NOT the generic SPA" "$RESP" 'Unstream - Support Artists Directly'

info "Testing /a/kingtriumph — browser User-Agent"
RESP=$(curl -s "$BASE/a/kingtriumph" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
check_contains "kingtriumph page contains artist name" "$RESP" "kingtriumph"
check_contains "kingtriumph page has platforms" "$RESP" "bandcamp"

info "Testing /a/kid-lightbulbs — bot User-Agent (should also get SSR)"
RESP=$(curl -s "$BASE/a/kid-lightbulbs" -H "User-Agent: Twitterbot/1.0")
check_contains "bot gets SSR HTML" "$RESP" "Kid Lightbulbs"
check_contains "bot gets OG tags" "$RESP" 'og:title'

# ============================================================
section "2. Artist Lookup API"
# ============================================================

info "Testing /api/artist?slug=kid-lightbulbs"
RESP=$(curl -s "$BASE/api/artist?slug=kid-lightbulbs")
check "kid-lightbulbs returns 200" "$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if 'id' in d else 'fail')" 2>/dev/null || echo 'error')" "ok"
check_contains "kid-lightbulbs has matchConfidence=claimed" "$RESP" '"claimed"'
check_contains "kid-lightbulbs has platforms" "$RESP" "bandcamp"

info "Testing /api/artist?slug=kingtriumph"
RESP=$(curl -s "$BASE/api/artist?slug=kingtriumph")
check "kingtriumph returns 200" "$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print('ok' if 'id' in d else 'fail')" 2>/dev/null || echo 'error')" "ok"
check_contains "kingtriumph has matchConfidence=claimed" "$RESP" '"claimed"'
check_contains "kingtriumph name is kingtriumph" "$RESP" '"kingtriumph"'

info "Testing /api/artist?slug=king-triumph (hyphenated variant)"
RESP=$(curl -s "$BASE/api/artist?slug=king-triumph")
check "king-triumph resolves to kingtriumph" "$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('slug','') or d.get('id',''))" 2>/dev/null || echo 'error')" "kingtriumph"

info "Testing /api/artist?slug=nonexistent-artist-12345"
RESP=$(curl -s "$BASE/api/artist?slug=nonexistent-artist-12345")
check "nonexistent artist returns 404" "$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error','ok'))" 2>/dev/null || echo 'ok')" "Artist not found"

# ============================================================
section "3. Search API"
# ============================================================

info "Testing /api/search/sources?query=king+triumph"
RESP=$(curl -s "$BASE/api/search/sources?query=king+triumph")
RESULTS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null || echo '0')
check "search returns results" "$RESULTS" "1"
check_contains "search result is claimed" "$RESP" '"claimed"'
check_contains "search result has kingtriumph" "$RESP" "kingtriumph"

info "Testing /api/search/sources?query=kid+lightbulbs"
RESP=$(curl -s "$BASE/api/search/sources?query=kid+lightbulbs")
RESULTS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null || echo '0')
check "search returns results for kid lightbulbs" "$RESULTS" "1"
check_contains "kid lightbulbs search result is claimed" "$RESP" '"claimed"'

# ============================================================
section "4. Saved Artists API (no auth — should return 401)"
# ============================================================

info "Testing /api/saved-artists without auth"
RESP=$(curl -s "$BASE/api/saved-artists")
check "unauthenticated GET returns 401" "$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null || echo 'parse-error')" "Not authenticated"

RESP=$(curl -s -X POST "$BASE/api/saved-artists" -H "Content-Type: application/json" -d '{"artistId":"test"}')
check "unauthenticated POST returns 401" "$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null || echo 'parse-error')" "Not authenticated"

# ============================================================
section "5. Content-type Check (SPA fallback protection)"
# ============================================================

info "Testing /data/artists/kid-lightbulbs.json (should return HTML from SPA fallback)"
RESP_HEADERS=$(curl -sI "$BASE/data/artists/kid-lightbulbs.json")
check_contains "SPA fallback returns HTML content-type" "$RESP_HEADERS" "text/html"
# The ArtistPage should skip this in step 1 and fall through to the API

info "Testing /api/artist?slug=kid-lightbulbs (should return JSON)"
RESP_HEADERS=$(curl -sI "$BASE/api/artist?slug=kid-lightbulbs")
check_contains "API returns JSON content-type" "$RESP_HEADERS" "application/json"

# ============================================================
section "6. Dashboard Page"
# ============================================================

info "Testing /dashboard (should load, not redirect)"
RESP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/dashboard")
check "dashboard returns 200" "$RESP" "200"

# ============================================================
section "Results"
# ============================================================

echo ""
echo "========================================"
echo -e "  Passed: \033[32m$PASS\033[0m  Failed: \033[31m$FAIL\033[0m"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi