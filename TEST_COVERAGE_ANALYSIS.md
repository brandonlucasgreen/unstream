# Test Coverage Analysis

## Current State

The codebase has **6 test files (~777 lines)** covering **56 source files (~11K LOC)**. Tests are focused almost exclusively on the search pipeline utilities in `netlify/functions/search-utils.ts`.

### What IS Tested

| Area | File | Tests |
|------|------|-------|
| Aggregation | `search-utils.ts` → `aggregateResults` | Merging, splitting, filtering, sorting |
| Normalization | `search-utils.ts` → `normalizeAccents`, `normalizeForComparison`, `namesMatch`, `textMatchScore` | Accent handling, case folding, fuzzy matching |
| Identifiers | `search-utils.ts` → `generateResultId`, `extractPlatformIdentifier`, `isQobuzVariation`, `isSearchOnlyLink` | URL parsing, ID generation, platform detection |
| Disambiguation | `search-utils.ts` → 8 functions covering the entire cross-platform dedup pipeline | Release comparison, Qobuz dedup, split/merge logic |
| Integration | `search-accuracy.test.ts` | 9 end-to-end search scenarios against live APIs |

### What is NOT Tested

Everything else — roughly **90% of the codebase by file count** has zero test coverage.

---

## Recommended Areas for Improvement

### 1. `src/services/sources.ts` — Multi-Artist Query Parsing & Result Merging (HIGH PRIORITY)

**Why:** This file contains critical client-side business logic that transforms user input before it hits the API. Bugs here silently break searches for collaborative tracks.

**Specific functions to test:**
- `parseMultiArtistQuery()` — Splitting `"Artist1 feat. Artist2"`, `"A & B"`, `"A x B"` etc. Edge cases: `"The xx"` should NOT split on `x`, single-word queries, trailing separators.
- `mergeSearchResponses()` — Deduplication by normalized name, image URL inheritance, match confidence upgrading, sorting by relevance then platform count.
- `mergeWithMusicBrainzData()` — Adding official site, Discogs, library services, and social links to matching results. Platform sorting logic (social last, official/library in middle). Replacement of search URLs with direct URLs.
- `normalizeForComparison()` / `textMatchScore()` — These are duplicated from `search-utils.ts` with slightly different implementations. Tests would catch divergence.

**Estimated effort:** ~150 lines of tests. All functions are pure or easily mockable.

---

### 2. `src/utils/bandcamp-friday.ts` — Date Utility (LOW EFFORT, HIGH VALUE)

**Why:** This is a tiny pure function with timezone-sensitive logic that's easy to get wrong. It affects a user-facing banner.

**Specific tests:**
- Known Bandcamp Friday dates return `true`
- Non-Bandcamp-Friday dates return `false`
- Timezone boundary behavior (11:59 PM PT vs 12:00 AM PT)
- Passing a custom `Date` object works correctly

**Estimated effort:** ~30 lines of tests.

---

### 3. `api/search/sources.ts` — Platform Search Functions (HIGH PRIORITY)

**Why:** This is the core backend search orchestration. It contains HTML scraping logic for Bandcamp, Mirlo, Qobuz, Patreon, Bandwagon, and Faircamp — all of which can break silently when upstream sites change their markup.

**What to test (with mocked `fetch`):**
- `searchBandcamp()` — Parse `.searchresult` elements from HTML fixtures. Test artist/album/track type detection, image extraction, `by ` prefix stripping.
- `searchMirlo()` — OG title matching logic (rejects pages where og:title is just "Mirlo").
- `searchQobuz()` — Regex extraction of `/interpreter/{slug}/{id}` from HTML.
- `searchPatreon()` — JSON API parsing, URL slug indexing, deduplication.
- `searchBandwagon()` — Link extraction from `a[href*="bandwagon.fm/@"]`, name matching logic.
- `searchFaircamp()` — Directory JSON lookup, artist name matching, result limiting.
- `aggregateResults()` (the version in this file) — Similar to the tested version in `search-utils.ts` but with slightly different behavior.
- `searchAllPlatforms()` — Orchestration: verifies that Bandcamp-found artists get Ampwall/Ko-fi links, that platform matching works correctly, and that `Promise.allSettled` failures are handled gracefully.

**Approach:** Create HTML fixture files for each platform's search results page. Mock `fetch`/`fetchWithTimeout` to return these fixtures.

**Estimated effort:** ~300-400 lines of tests.

---

### 4. `netlify/functions/search-utils.ts` — Untested Functions (MEDIUM PRIORITY)

**Why:** While this file is the most-tested, two exported functions lack coverage:

- `collectReleaseTitles()` — Collects titles from both `allReleaseTitles` and `latestRelease.title`. Should handle missing data gracefully.
- `createOrphanedQobuzStandalones()` — Re-creates standalone results for Qobuz profiles removed from all results. Important for the "no artist left behind" guarantee.

**Estimated effort:** ~60 lines of tests.

---

### 5. `netlify/functions/cache.ts` — Cache Utilities (MEDIUM PRIORITY)

**Why:** The cache-aside pattern in `cacheGetOrFetch()` has subtle correctness requirements (fire-and-forget write, null vs undefined handling). The `cacheDeleteByArtist()` function does cursor-based scanning that could have off-by-one bugs.

**What to test (with mocked Redis):**
- `cacheGetOrFetch()` — Returns cached data on hit, calls fetch function on miss, writes to cache after miss.
- `artistCacheKey()` — Normalization of query strings (spaces → underscores, lowercasing, trimming).
- `cacheDeleteByArtist()` — Pattern matching and batch deletion.

**Estimated effort:** ~80 lines of tests.

---

### 6. `api/search/site-search.ts` — DuckDuckGo Site Search (MEDIUM PRIORITY)

**Why:** This module scrapes DuckDuckGo HTML results and applies per-site URL extraction rules. It's fragile by nature and would benefit from regression tests with HTML fixtures.

**What to test:**
- `searchDuckDuckGo()` — URL extraction from `uddg=` redirect format, domain validation, per-site extractUrl rules (Ko-fi excludes `/post/` and `/shop/`, Patreon excludes `/posts/`, etc.).
- `handler()` — Input validation (missing query, missing site, invalid site), CORS headers, HTTP method check.

**Estimated effort:** ~100 lines of tests.

---

### 7. `netlify/functions/search-sources.ts` (Netlify version) — Serverless Handler (LOWER PRIORITY)

**Why:** This is the Netlify Functions wrapper around the search pipeline. Testing the handler ensures proper HTTP response codes, CORS headers, error handling, and the `hasPendingEnrichment` flag.

**What to test:**
- Returns 405 for non-GET requests
- Returns 400 for missing query parameter
- Returns proper CORS headers
- Returns `hasPendingEnrichment: true` when results exist
- Returns 500 with error structure on failure

**Estimated effort:** ~60 lines of tests.

---

### 8. `src/services/auth.ts` — Auth Service (LOWER PRIORITY)

**Why:** Auth bugs are high-severity. Testing the guard clauses (missing env vars → null client → graceful fallback) prevents silent auth failures.

**What to test (with mocked Supabase):**
- `getSupabaseClient()` returns null when env vars are missing
- `signInWithMagicLink()` returns error string when auth is not configured
- `getSession()` returns null when client is null
- `signOut()` is a no-op when client is null

**Estimated effort:** ~50 lines of tests.

---

## Summary: Priority Ranking

| Priority | Area | Effort | Impact |
|----------|------|--------|--------|
| 1 | `src/services/sources.ts` (multi-artist parsing, merge logic) | Medium | High — user-facing search quality |
| 2 | `api/search/sources.ts` (platform scrapers) | High | High — core functionality, fragile scraping |
| 3 | `src/utils/bandcamp-friday.ts` | Low | Medium — quick win, timezone-sensitive |
| 4 | `netlify/functions/search-utils.ts` (remaining functions) | Low | Medium — completes existing coverage |
| 5 | `netlify/functions/cache.ts` | Medium | Medium — data integrity |
| 6 | `api/search/site-search.ts` (DuckDuckGo scraping) | Medium | Medium — fragile scraping logic |
| 7 | Netlify function handlers (HTTP layer) | Low | Lower — thin wrappers |
| 8 | `src/services/auth.ts` | Low | Lower — thin Supabase wrapper |

### Not Recommended for Unit Testing

- **React components** (`src/components/`, `src/pages/`) — These are presentation-heavy with minimal logic. Component testing would require a DOM environment (jsdom/happy-dom) and provide low ROI given the app's nature. If UI testing is desired, consider E2E tests with Playwright instead.
- **Edge functions** (`netlify/edge-functions/`) — These are SSR/SEO wrappers that inject meta tags. Better tested via integration/E2E.
- **Scripts** (`scripts/`) — One-off data generation scripts that are run manually.
