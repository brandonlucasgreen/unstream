---
status: Done
---
# UNS — Library Import for Mac app

**GitHub Issue:** [#151](https://github.com/brandonlucasgreen/unstream/issues/151)
**Spec body:** GH issue body is the source of truth (this doc is the working expansion for Daryl)
**Owner:** Daryl
**Reviewer:** Brandon (via Claude Code — Dan review intentionally skipped for this round; backend work is bounded and well-understood OAuth territory)
**Coordinator:** Wayne
**Status:** Draft, awaiting Brandon's review
**Lane:** Maintenance mode (Unstream) — explicit opt-in by Brandon on 2026-06-27 to spec the open feature issues against GitHub, not Linear.

## Why this exists

Today Unstream is a one-artist-at-a-time lookup. This feature flips the model: **bulk discovery from a user's existing library** is the conversion moment that pulls people in and gets them to start saving artists (which is what feeds the rest of the app — extensions, alerts, share-list, etc.).

GH #151 frames it as the answer to "how much of my music library is already available on platforms that pay better?" — and the *report* is the hook. We don't need to migrate anyone's listening; we just need to show them the overlap.

## Product framing (from GH #151, restated)

- **Goal:** connect a streaming library → match the user's saved/followed artists against Unstream's existing search index (the 17-platform lookup pipeline) → show a report of overlap → funnel into Unstream's save/follow flow.
- **The conversion moment is the report, not the connection.** Connecting is necessary but not the value; the value is "X of your Y artists are on Bandcamp, here's the list."
- **Re-engagement hook:** stored results let us say "2 new artists from your library are now on Bandcamp since your last scan." This is the always-on value.
- **Out of scope (v1):** importing or syncing lists from third-party music services, modifying user data on the connected service, real-time sync (we scan once, optionally re-scan on demand).

## Source selection — MVP ordering (Brandon's call)

Three sources proposed in GH #151. Different cost/risk profiles. I'd build in this order:

| # | Source | Why this order |
|---|---|---|
| 1 | **Last.fm** | Public API, no OAuth required for profile reads. Last.fm users are data-curious — the audience overlap with Unstream is highest. Lowest cost to ship. |
| 2 | **Spotify** | High audience overlap, OAuth is well-understood, but Spotify has been tightening third-party API access (verify library-read access is still available for new apps in 2026 before scoping). |
| 3 | **Apple Music** | Most complex (MusicKit JS + dev tokens + user tokens + Apple Developer Program). Defer until #1 and #2 are live and we have signal on demand. |

**Recommendation: ship Last.fm first, prove the pattern, then add Spotify.** Apple Music waits for demand signal. Brandon's call on whether to commit to all three or stop after two.

## Open product decisions (Brandon's call — surface in the PR description, don't block on these)

1. **Account requirement.** GH #151 asks: does the user need an Unstream account? **Recommendation: yes for the save/follow step (which is the conversion), but the initial report view should work without an account** — anonymous scan, then prompt to sign up to save. This matches the existing app's "browse without account, sign up to claim" pattern.
2. **Stored results vs. one-shot scan.** GH #151 flags this as an open question. **Recommendation: store results.** Stored results enable the re-engagement hook ("2 new artists from your library are now on Bandcamp since your last scan"), which is the long-term value. Storage cost is bounded — one row per (user, source, scan-time), capped at ~3 scans per user.
3. **Re-scan cadence.** Manual re-scan only in v1. Don't auto-rescan (would burn rate limits and surprise users). Add a "Rescan" button on the results page. Defer automated re-scans until we have usage data.
4. **Privacy disclosure.** GH #151 says "aligns with Unstream's values to be transparent and minimal." **Recommendation:** before any library data leaves the user's device, show a clear one-screen disclosure: "We'll read your library and match it against our platform index. We don't modify your [Spotify/Last.fm/etc] account. Your library data is stored encrypted. You can delete it anytime." Plus a link to a privacy-page detail.

## What to build

### 1. Last.fm integration (MVP)

**OAuth flow:** Last.fm uses an API-key + session-key model, not standard OAuth. Flow:

1. User clicks "Connect Last.fm" → redirect to Last.fm auth page.
2. Last.fm redirects back with a `token`.
3. We exchange the `token` for a `session_key` via `auth.getSession` API call.
4. Store the `session_key` server-side, keyed by user_id.

**Library read:** call `user.getTopArtists` (period: overall, limit: 1000) and `library.getArtists` (paginated). Combine into a single deduped list. This is the user's "library."

**No write operations.** Read-only by design. This is a hard rule per GH #151.

### 2. Match pipeline (existing infrastructure, batched)

**Don't reinvent the search.** The existing `/api/search` endpoint already runs an artist name against the 17-platform index. For library import, we wrap that endpoint in a queue-driven batch job:

- One artist per lookup. Don't batch into one giant call (the existing API wasn't built for that).
- Sequential with rate limiting: 5 lookups/sec max. Configurable.
- Cache results in a short-lived KV (15-minute TTL keyed by artist name) to dedupe within a single scan.
- For 1,000 artists at 5/sec, a full scan is ~3.5 minutes. Show progress.

**Job runner:** use Supabase Edge Functions or Netlify Functions + a simple queue table. GH #151 suggests either; I'd default to **a Postgres-backed job queue** (a `import_jobs` table with `status` and `progress` columns) since we already run Supabase. Keep it boring — no Redis, no BullMQ.

### 3. Storage

**New tables (one Supabase migration):**

```sql
-- The connection: which user has connected which source
CREATE TABLE library_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES <user-table>(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('lastfm', 'spotify', 'apple_music')),
  external_user_id TEXT NOT NULL,        -- Last.fm username, Spotify user ID, etc.
  session_data JSONB NOT NULL,           -- encrypted session_key / refresh_token
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  UNIQUE (user_id, source)
);

-- One scan = one row. We keep the last 3 scans per (user, source) for re-engagement.
CREATE TABLE library_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES <user-table>(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES library_connections(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  total_artists INT,
  matched_artists INT,
  results JSONB,                         -- structured report
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error TEXT
);

-- Per-artist match record (for the report detail view + re-engagement diff)
CREATE TABLE library_scan_artists (
  scan_id UUID REFERENCES library_scans(id) ON DELETE CASCADE,
  artist_name TEXT NOT NULL,
  matched_slug TEXT,                     -- Unstream slug if matched
  matched_platforms TEXT[],              -- array of platform keys where found
  supported BOOLEAN,                     -- NULL if not in user's saved list, true/false if so
  PRIMARY KEY (scan_id, artist_name)
);
```

**Retention:** keep the last 3 scans per (user, source). Older scans are pruned by a cron.

**RLS:**
- `library_connections`: read+write only for the owning user. Server-side only (no anon access).
- `library_scans`: read-only for the owning user. Server-side only.
- `library_scan_artists`: read-only for the owning user. Server-side only.

### 4. API endpoints

**New endpoints:**

- `POST /api/library/connect/lastfm` — initiate the OAuth-ish handshake. Body: `{ token }` (Last.fm's auth token). Returns the new `connection_id`.
- `DELETE /api/library/connect/{connection_id}` — disconnect. Hard-deletes the connection + cascades scans (or marks `disconnected_at` and keeps the historical scans — Brandon's call).
- `POST /api/library/scan/{connection_id}` — kick off a scan. Returns `{ scan_id }`. Idempotent (cancels any in-progress scan for the same connection).
- `GET /api/library/scan/{scan_id}` — returns `{ status, progress: { total, completed }, results }`. Polled by the frontend.
- `GET /api/library/scans` — list the user's scans (most recent first). For the re-engagement view.

**Existing endpoints to reuse:**

- `/api/search` — called per-artist by the batch job, not by the user.
- `/api/saved-artists` — joined with `library_scan_artists.supported` to mark which matched artists are already in the user's saved list.

**Rate limits:**

- Last.fm: 5 req/sec (their published limit). 1,000 artists = 200 sec minimum.
- Internal job runner: 5 lookups/sec against `/api/search` (configurable, default 5).
- `POST /api/library/scan` rate-limited to 1 per connection per hour (avoid spam-scanning).

### 5. Frontend — flow

**Entry point:** "Import your library" button on `/dashboard` and on the Mac app's main view.

**Step 1: Source picker.** Three cards (Last.fm / Spotify / Apple Music). Show which are available (Last.fm is always available; Spotify/Apple gated by env config). Click a card → connection flow.

**Step 2: Connection flow (Last.fm).**
- Click "Connect Last.fm" → opens Last.fm auth in a new tab.
- Last.fm redirects to `https://unstream.stream/library/connect/lastfm/callback?token=...`.
- We exchange the token, store the session_key, redirect back to `/dashboard?library=connected&source=lastfm`.

**Step 3: Scan trigger.** After successful connection, show a "Scan your library" CTA. Click → starts the scan, navigates to the scan-progress page.

**Step 4: Progress view.** Polls `GET /api/library/scan/{scan_id}` every 3 seconds. Shows: "Matched X of Y artists so far..." with a progress bar. Cancel button stops the scan.

**Step 5: Results view.** Once complete, shows the report:
- Headline: "**127 of your 842 artists are on at least one alternative platform.**"
- Per-platform breakdown: "Bandcamp: 89, Mirlo: 24, Faircamp: 18, Qobuz: 67..." (deduped — an artist on multiple platforms counts in each).
- Filterable list of matched artists, each linking to the artist's Unstream page.
- Each artist row has a "Save" button (calls existing `/api/saved-artists` POST). Bulk-save all is a nice-to-have, defer.

**Re-engagement view (later):** "Since your last scan 2 weeks ago, 4 new artists from your Last.fm library are now on Bandcamp." Only shown if we have >1 scan for that source.

### 6. Mac app entry point

Per the issue's title — "Library import feature for **Mac app**". The web app should also have this (per Brandon's "for the Mac app" likely just means the entry point lives on the Mac side too, or it's a Mac-first feature). **Recommendation: ship web first, add Mac-app surface next.** The web flow above covers the data layer; the Mac app just needs:
- A "Import Library" menu item.
- A sheet that hosts the web flow (or reimplements it natively — Daryl's call).

Defer the Mac-native surface until the web flow is proven. Don't block V1 on Mac-native UI.

### 7. Files to touch / create

**New:**
- `api/functions/library/connect-lastfm.ts` — Last.fm token exchange
- `api/functions/library/disconnect.ts` — disconnect a connection
- `api/functions/library/start-scan.ts` — kick off a scan (writes to queue)
- `api/functions/library/scan-status.ts` — poll endpoint
- `api/functions/library/list-scans.ts` — recent scans
- `api/functions/library/_run-scan.ts` — the actual scan worker (called by the queue)
- `apps/web/src/pages/LibraryImportPage.tsx` — entry + source picker
- `apps/web/src/pages/LibraryScanProgressPage.tsx` — progress polling view
- `apps/web/src/pages/LibraryResultsPage.tsx` — report view
- `apps/web/src/components/LibrarySourceCard.tsx`
- `apps/web/src/components/LibraryMatchRow.tsx`
- A new Supabase migration for `library_connections`, `library_scans`, `library_scan_artists`

**Modified:**
- `apps/web/src/App.tsx` — add routes
- `apps/web/src/pages/DashboardPage.tsx` — add "Import library" CTA
- `api/functions/_shared/lastfm-client.ts` — new shared client (or wherever API clients live)
- `data/shipped-features.json` — add entry on merge

### 8. Tests

- Unit: Last.fm token exchange (success / bad token / expired token).
- Unit: scan worker — handles per-artist failures gracefully (one bad artist doesn't fail the scan).
- Unit: scan progress endpoint returns correct shape.
- Unit: rate limiting on `POST /api/library/scan`.
- Integration: end-to-end with a test Last.fm account (or mocked Last.fm API). Verify scan completes, results are correct, save buttons work.
- Security: RLS denies cross-user access. Session keys are encrypted at rest. Disconnect cascades correctly.

## Engineering principles (per CLAUDE.md)

- **Boring beats clever.** The job queue is a Postgres table with `status` and `progress` columns. No Redis. No BullMQ. No fancy worker framework.
- **One route, one renderer.** New library pages are SPA routes. No edge function SSR for these — they need authentication + dynamic data.
- **Match surrounding code.** Reuse `/api/search` for the per-artist match. Don't build a parallel search pipeline.
- **RLS on every new table.** All three new tables ship with RLS in the migration.
- **No secrets in code or logs.** Last.fm API key is in env. Session keys are stored encrypted. Don't log session keys.
- **Read-only by design.** No code path writes to Last.fm/Spotify/Apple on the user's behalf. This is a hard product rule, enforced by what the API client methods we expose do (read-only methods only).
- **Validate external input at boundaries.** Last.fm sends us tokens and library data; both go through validation.

## Acceptance criteria (V1 = Last.fm only)

- [ ] User can connect Last.fm from `/dashboard` or `/library/import`.
- [ ] User can disconnect Last.fm; the disconnect cascades to past scans or marks them historical (TBD).
- [ ] User can trigger a scan; progress is visible; scan completes within 5 minutes for a 1,000-artist library.
- [ ] Results page shows matched artists, per-platform breakdown, and a Save button per artist.
- [ ] Save buttons work and integrate with the existing saved-artists flow.
- [ ] User can re-scan (rate-limited to 1/hour).
- [ ] Re-engagement view shows "new matches since last scan" if applicable.
- [ ] Library data is stored encrypted. RLS denies cross-user reads. Session keys are not exposed to the client.
- [ ] Privacy disclosure is shown before any data leaves the user's device.
- [ ] No write operations to the connected source — verified by API client scope.

## What this spec does NOT cover

- Spotify + Apple Music (deferred per source-selection priority above).
- Mac-native import UI (deferred until web flow is proven).
- Auto-rescan (deferred until we have usage data).
- Real-time sync with the connected source (out of scope for V1).
- Cross-source dedup (a user with Last.fm AND Spotify might have overlaps; we treat them as separate scans).

## Implementation order (suggested)

1. Migration (3 new tables + RLS).
2. Last.fm client + token exchange endpoint.
3. Disconnect endpoint.
4. Scan worker (Postgres-queue-based).
5. Start-scan + status + list-scans endpoints.
6. Web entry + source picker + connection flow.
7. Scan progress view.
8. Results view + Save integration.
9. Privacy disclosure copy + page.
10. End-to-end smoke test with a real Last.fm account.
11. `data/shipped-features.json` entry.

## Files for Daryl to reference

- `api/functions/saved-artists.ts` — closest analog to the new endpoints; match the patterns.
- `apps/web/src/pages/DashboardPage.tsx` — where to add the entry CTA.
- `apps/web/src/components/ResultCard.tsx` — for the artist rows in the results view.
- `api/shared/platform-registry.ts` — the 17-platform index; the scan worker uses this for matching.
- `~/projects/unstream/CLAUDE.md` — Engineering principles.
- `~/projects/unstream/docs/superpowers/` — if there are design conventions for new feature flows (verify before assuming).