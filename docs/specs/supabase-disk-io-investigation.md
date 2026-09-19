# Supabase disk I/O: what is spending it, and what we turned off

**Date:** 2026-08-30
**Trigger:** a third Supabase warning that the project's disk I/O budget is depleting, after
rounds 1 and 2 of I/O work (#443, #463, #464) each bought some headroom back.

## The short version

Release cataloging is the culprit, and specifically the **`searched` trigger** — the path that
handed every Bandcamp-linked artist in a search result to the background crawler. That trigger is
now removed. The rest of the feature (saves, the artist's own button, the admin command, the
Bandcamp collection import, the six-hourly sweep) is untouched and still runs.

This document records the arithmetic, and the SQL that confirms it against production, because
the model below is derived from the code and from measurements recorded in comments — it is not
itself a measurement of the live database.

## Why the search trigger and not the sweep

Both feed the same background function, so per artist they cost the same. What differs is how
many artists they can feed it.

| Trigger | Ceiling | Artists / day |
|---|---|---|
| `scheduled` (the six-hourly sweep) | 25 per run, 4 runs a day, hard-coded | **100** |
| `searched` | `CATALOG_HOURLY_CAP.searched` = 60 an hour | **up to 1,440** |

The sweep's number is a constant. The search number is a function of traffic: it rose with every
new visitor, with no feedback loop back to the database's capacity. That shape — an
unauthenticated, unbounded, traffic-driven writer — is the one that produces a warning that keeps
coming back after each round of point fixes, because the point fixes reduce cost *per unit* while
the number of units keeps climbing.

It also explains the timing. Rounds 1 and 2 both cut per-operation cost (stop rewriting unchanged
rows, batch reads, add indexes, cache the hot public reads). Neither touched how many artists get
crawled. Search traffic grew; the budget went again.

## What one catalogue pass costs the database

Per artist claimed (`claimArtistForCatalog` → `catalogArtist`):

- 2 queries to decide, plus 1 upsert to claim — paid even for an artist the cooldown then refuses.
- 1 read of the artist and their links.
- `persistReleases`: 1 read of existing releases + 1 read of existing sources, then **1 insert per
  new release** and **1 insert per new release source**.
- The detail pass: up to `MAX_DETAIL_FETCHES_PER_ARTIST` (40) release pages, each one
  `persistReleaseDetail` — a read, then on a change a release update plus **one row per offer**,
  plus a prune delete.
- `catalogMusicBrainz`, and a Discogs / Faircamp / jam.coop / Mirlo pass where a link exists.
- `linkCollectionItemsForArtist`, then `recordCatalogOutcome` (a read and an update).

The write targets are `releases`, `release_sources` and `release_offers`. All three carry six
indexes, so every insert is seven physical writes plus WAL, and every row eventually costs an
autovacuum pass. A first-time catalogue of a mid-sized artist — measured median 7 releases, p90 19
— is therefore on the order of a few hundred physical writes, and the tail of large artists is
much worse.

Growth bears this out: the feature shipped 2026-07-31, and by 2026-08-07 held 5,977 releases
across 803 artists. That is ~850 release rows a day *in the first week*, before offers, before
sources, and before any of it started being re-read.

## The 30-day refresh makes the writes permanent

`DETAIL_REFRESH_DAYS = 30` means every release source is re-fetched and re-compared monthly,
forever. So the search trigger did not just spend I/O once per artist discovered — it added that
artist to a recurring monthly workload. Every artist search has ever touched is still being paid
for. That is the compounding term, and it is why turning the tap off matters more than making
each drop cheaper.

## Confirm it against production

Paste this into the Supabase SQL editor. It answers "which tables are actually moving the disk"
without guessing. (`pg_stat_statements` is enabled on Supabase by default; if the last query
errors, skip it and rely on the first three.)

```sql
-- 1. Biggest tables, and how much of that is indexes.
-- Both views expose relname/relid, so every reference is alias-qualified; a bare `relname`
-- here is ambiguous and errors.
SELECT s.relname AS table,
       pg_size_pretty(pg_total_relation_size(s.relid))                             AS total,
       pg_size_pretty(pg_relation_size(s.relid))                                   AS heap,
       pg_size_pretty(pg_total_relation_size(s.relid) - pg_relation_size(s.relid)) AS indexes,
       t.n_live_tup AS live_rows
FROM pg_catalog.pg_statio_user_tables s
JOIN pg_stat_user_tables t USING (relid)
ORDER BY pg_total_relation_size(s.relid) DESC
LIMIT 20;

-- 2. Write volume and vacuum pressure per table since stats were last reset.
--    The releases/release_sources/release_offers trio should dominate ins+upd+del.
SELECT relname AS table,
       n_tup_ins AS inserts, n_tup_upd AS updates, n_tup_del AS deletes,
       n_dead_tup AS dead_rows,
       autovacuum_count, autoanalyze_count,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC
LIMIT 20;

-- 3. Reads that missed the cache and went to disk. heap_blks_read is the disk half;
--    a large read count next to a small hit count is a table that no longer fits in RAM.
SELECT relname AS table,
       heap_blks_read AS heap_disk_reads, heap_blks_hit AS heap_cache_hits,
       idx_blks_read  AS idx_disk_reads,  idx_blks_hit  AS idx_cache_hits
FROM pg_statio_user_tables
ORDER BY (heap_blks_read + idx_blks_read) DESC
LIMIT 20;

-- 4. The statements doing the most block I/O.
SELECT calls,
       round(total_exec_time::numeric, 0) AS total_ms,
       shared_blks_read  AS disk_reads,
       shared_blks_dirtied AS blocks_dirtied,
       shared_blks_written AS blocks_written,
       left(query, 160) AS query
FROM pg_stat_statements
ORDER BY (shared_blks_read + shared_blks_dirtied) DESC
LIMIT 25;
```

What confirms the diagnosis: `releases`, `release_sources` and `release_offers` sitting at the top
of queries 1 and 2, with `release_offers` in particular showing high `n_tup_ins` + `n_tup_del`
(offers are inserted and pruned, so they generate dead tuples fast). What would *refute* it:
`app_events` dominating instead — it has no row retention at all, only a 90-day session-hash
scrub, so it is the plausible alternative culprit and worth ruling out with the same queries.

## What changed in code

`persistSearchResults` in `api/functions/db.ts` no longer collects Bandcamp-linked artists or
calls `requestArtistCatalog(..., 'searched')`. That is the whole change. Nothing else about
cataloging moved.

The `'searched'` member of `CatalogTrigger` and its hourly cap stay: the background function falls
back to it for an unrecognized trigger, and it is the smallest of the three budgets, so it remains
the right fail-closed default.

## What this costs the product

A brand-new artist page shows no releases until the sweep reaches that artist. The sweep's pool is
every artist with a bandcamp, discogs, faircamp, jam.coop or mirlo link, at 100 a day, so with a
pool measured at 2,564 on 2026-08-02 that is roughly a month of latency in the worst case, and
sooner for anyone who saves the artist (saved artists sort first in
`getStaleCatalogCandidates`).

Saved artists — the ones where a release alert is a promise to a real person — are unaffected:
saving still catalogues immediately, and it holds the largest hourly budget.

## If the warning comes back anyway

In escalating order, cheapest first:

1. **Slow the sweep.** Change the cron in `.github/workflows/recatalog-sweep.yml` from
   `0 1,7,13,19 * * *` to daily. 100 artists/day → 25.
2. **Lengthen the detail refresh.** `DETAIL_REFRESH_DAYS` in `catalog-artist-background.ts`, 30 →
   90. Prices go staler; the recurring monthly workload drops to a third.
3. **Add retention to `app_events`.** It has never had any. A `DELETE FROM app_events WHERE
   created_at < now() - interval '180 days'` on the existing pg_cron schedule, in a migration.
4. **Stop cataloging entirely, with no deploy.** Delete `RELEASE_CATALOG_ENABLED` from the Netlify
   site's environment variables (Functions scope, Production context). Both the caller and the
   background function check it, so everything stops at once. Note that the six-hourly sweep
   workflow will then fail loudly on a 503 every run — that is deliberate, but disable the
   workflow's schedule at the same time so the failures aren't noise.

---

# Round 4 (2026-09-05): the warning is back — what is still writing

**Trigger:** the disk I/O budget warning returned within a week of #494 removing the `searched`
catalogue trigger. This section is a fresh code audit of every path that reaches Supabase: what
each one writes per unit of traffic, how many index entries that write costs, and what would
remove it. As with the section above, it is derived from the code, not measured on the live
database — the SQL at the end is what turns it into a measurement.

## The short version

Nothing new appeared. What remains is the sum of five things, in rough order of weight:

1. **Release cataloguing is still the largest writer**, now through the sweep alone. The pool
   still carries a first-time backlog measured in the thousands, and a first-time catalogue is
   the expensive case — every row it inserts pays for nine indexes on `releases`.
2. **Phase 2 enrichment (`persistEnrichment`) rewrites rows on every request**, unchanged or
   not. It is the one search-time writer that round 1 (#463) did not diff, and it runs *after*
   the Redis cache read, so a cache hit still writes.
3. **Every `artists` update is made deliberately expensive by an index nothing queries.**
   `idx_artists_updated` indexes `updated_at`; every write to the table bumps `updated_at` via
   trigger; so no update on `artists` can be a cheap in-place ("HOT") update, and every one
   re-enters the row in all six indexes, including the trigram GIN on `name`.
4. **`app_events` grows forever, carries six indexes including one exact duplicate, and every
   row is rewritten a second time at 90 days** by the session-hash scrub.
5. **Three clients write analytics per track, not per session**, and the Mac app writes two
   `search` rows per search — the double-write the web app fixed on 2026-08-19.

Four of the five are code and migration changes with no product trade-off. The fifth (retention
on `app_events`) and the sweep's dials are the owner's call.

## 1. Cataloguing: what one first-time artist costs now

Per artist, from `catalog-artist-background.ts` and `db.ts`:

| Step | Rows written | Indexes maintained per row |
|---|---|---|
| `claimArtistForCatalog` | 1 upsert on `release_catalog_state` | 3 (incl. `last_attempted_at`, so never HOT) |
| `persistReleases` | 1 insert per release into `releases` + 1 into `release_sources` | **9** on `releases`, 4 on `release_sources` |
| `catalogDetails` (up to 40 pages) | 1 `release_sources` stamp each, plus offers on change | 4 / 3 |
| `catalogDiscogs` | up to 5 masters → `releases` + `release_sources`, 5 detail stamps | 9 / 4 |
| `catalogMusicBrainz` | 1 `releases` update per matched group | 9 (via `updated_at` trigger; `updated_at` is not indexed on `releases`, so these *can* be HOT) |
| `recordCatalogOutcome` | 1 update on `release_catalog_state` | 3 |

Median 7 releases, p90 19. So a mid-sized first-time catalogue is on the order of 150–400
physical index+heap writes before WAL, and the p90 is roughly triple that. At 100 artists a day
with a backlog of ~1,700 never-catalogued artists (2,564 in the pool on 2026-08-02 against 803
catalogued on 2026-08-07 — re-measure), the sweep spends the next ~17 days doing the expensive
case almost every run, and only then settles into the cheaper 30-day refresh.

The `releases` index count matters because it multiplies everything above:

- `idx_releases_artist_id (artist_id)` is a strict prefix of
  `idx_releases_artist_chrono (artist_id, release_date, created_at)`. Postgres uses the wider
  index for any query the narrower one could serve. It is a wasted write on every insert.
- `idx_releases_match (artist_id, release_type, match_key)` was built when identity was
  `(release_type, match_key)`. The "Release dedup" section of `CLAUDE.md` records that type was
  removed from identity on 2026-08-29; the lookup is now by `(artist_id, match_key)` and the
  middle column only widens the index. Worth confirming its `idx_scan` before touching.

## 2. `persistEnrichment` is the un-diffed writer

`api/functions/search-musicbrainz.ts` → `persistEnrichment` runs on every function invocation
that resolves an artist name. Per call:

- **One `artist_links` upsert per enrichment link**, sequential, `ON CONFLICT DO UPDATE`.
  Postgres has no "skip if identical": each one is a new tuple version plus the
  `artist_links_updated_at` trigger. Official site, Discogs, hoopla, freegal, three to six
  socials, plus discovered platforms — typically 6–10 rows, every time.
- **One unconditional `artists.update({ last_enriched_at })`**, which fires the
  `artists_updated_at` trigger. Nothing reads `last_enriched_at` (grep: written in one place,
  read nowhere).

It runs after `cacheGetOrFetch`, so the 30-minute Redis cache saves the MusicBrainz round trip
but not the writes; only the CDN's 5-minute `s-maxage` does. Callers are the web app's Phase 2,
the extension's `enrichArtist` (per new artist, 30-minute client cache) and the Mac app's
`fetchMusicBrainzData`.

This is exactly the shape `persistSearchResults` had before #463 fixed it with
`artistNeedsRefresh` and `filterUnchangedLinks`. The same fix applies: one read of the artist's
current links, write only the rows that differ, and stamp the artist row at most once an hour
(or drop the stamp — see below).

## 3. `idx_artists_updated` turns every `artists` update into six index writes

A Postgres update is cheap ("HOT") only when no indexed column changes. `artists` has a trigger
that sets `updated_at = now()` on every update, and `idx_artists_updated` indexes that column.
So *every* update on the table — the hourly search refresh, enrichment, `died_on` backfills,
claims — is non-HOT and re-enters the row in all six indexes: the primary key, the `slug`
UNIQUE constraint, `idx_artists_slug`, `idx_artists_updated`, `idx_artists_living`, and the
trigram GIN on `name`. GIN entries are the expensive ones: one per trigram of the name.

No query uses the index. `updated_at` is read in exactly two places, both without a filter or
ordering on it: `getArtistBySlug` compares it in JavaScript against `FRESHNESS_TTL_MS`, and the
build-time sitemap selects `slug, updated_at` for every row. Dropping the index does not change a
single query plan, and turns the majority of `artists` updates into HOT updates.

`idx_artists_slug` is also redundant: `slug text unique not null` already creates a unique index
on the same column. Two indexes on `artists`, both pure write cost.

## 4. `app_events`: six indexes, no retention, two writes per row

The write path: `analytics-app-event.ts` inserts one row per event. The web app sends one per
search completion, platform click, artist page view and download. The extension sends **two per
track detection** (`extension_activated` and `search`), cache hit or not, by design. The Mac app
sends **two `search` rows per search** — "initiated" and "completed" — which is the double-write
`apps/web/src/services/analytics.ts` removed on 2026-08-19 with the comment "doubled the write
cost for no information". Nobody ported the fix.

The indexes, from three migrations that did not all know about each other:

| Index | From | Note |
|---|---|---|
| `app_events_pkey` | 2026-04-12 | |
| `idx_app_events_created_at (created_at desc)` | 2026-04-12 | |
| `idx_app_events_type_app (event_type, app, created_at desc)` | 2026-04-12 | |
| `idx_app_events_unscrubbed (created_at) WHERE session_hash IS NOT NULL` | 2026-08-08 | for the scrub |
| `idx_app_events_type_created (event_type, created_at desc)` | 2026-08-11 | overlaps `type_app` |
| `idx_app_events_created (created_at desc)` | 2026-08-11 | **exact duplicate** of `created_at` |

The 2026-08-11 migration's own comment says "the table's only index was
`idx_app_events_unscrubbed`". It wasn't; the original two were still there. Every insert pays six
index writes where three would do.

Then the nightly scrub (`expire_app_event_session_hashes`) sets `session_hash = NULL` on the
day that just turned 90. `session_hash` is the *predicate* of the partial index, so the update
changes index membership and cannot be HOT: each row is rewritten with six more index writes
and leaves a dead tuple for autovacuum. Every row this table has ever received is written twice.

## 5. Per-track analytics from the clients

Not a bug, but a multiplier worth stating: the extension and the Mac app poll the player every
3–5 seconds and treat every track change as a detection. Per track, the extension issues two
`app_events` inserts and one `increment_analytics` RPC per claimed artist in the results, and on
a 30-minute cache miss a full `/api/search/sources` (with `persistSearchResults` and the probe)
and a `/api/search/musicbrainz` (with §2's writes). The `extension_activated` event exists only
for the dashboard's "streaming services" breakdown, which is a per-session question being
answered with a per-track write.

## Smaller items, for completeness

- **`api_keys.last_used_at`** is rewritten on every authenticated v1 request
  (`authenticateApiKey` in `middleware.ts`). Stamp it at most hourly.
- **`artist_analytics` increments** (`increment_analytics` RPC) are `ON CONFLICT DO UPDATE` on a
  table whose indexed columns don't change, so they are HOT. Fine.
- **Reads that can miss the buffer cache.** A Nano instance has 0.5 GB of RAM in total; once the
  `releases` trio, `app_events` and the trigram GIN stop fitting, ordinary indexed reads become
  disk reads. Per search there are ~25 PostgREST round trips (`getArtistsBySlugs` ×3, the
  trigram ILIKE in `findKnownArtistSlugsByName`, the probe read, and two reads per persisted
  artist). Per crawler page view of `/a/:slug`, four queries including a nested
  releases→sources→offers select with `count: 'exact'`; the CDN holds it for a day but there are
  ~800 distinct pages and several crawlers. Query 3 below (heap/idx `blks_read`) is how to tell
  whether this is the dominant term. If it is, the fix is shrinking the working set — which is
  what §3, §4 and the index drops do anyway.
- Already right and not worth touching: `persistSearchResults` (throttled and diffed since
  #463), `me-listening` (diffed), the Bandcamp probe cache (write-once negatives),
  `saved-artists-sync` (5-minute pull of a ~40-row table), `check-releases` (weekly per client),
  the two pg_cron jobs (one statement each, nightly).

## Confirm before acting

Run the four queries in the section above first — they still answer "which tables move the
disk". Then this one, which answers "which indexes earn their writes":

```sql
-- 5. Index size and how often each has been used since stats were reset.
--    idx_scan = 0 on an index that isn't a UNIQUE constraint is a drop candidate.
SELECT s.relname AS table, s.indexrelname AS index,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       s.idx_scan AS scans,
       i.indisunique AS is_unique
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
ORDER BY s.relname, s.idx_scan;
```

What confirms §3 and §4: `idx_artists_updated`, `idx_artists_slug`, `idx_app_events_created_at`
(or `idx_app_events_created` — one of the pair) and `idx_releases_artist_id` at or near zero
scans while sitting at a meaningful size. What confirms §2: `artist_links` near the top of query
2's `n_tup_upd` with a `n_dead_tup` to match — those updates have no other high-volume source.

## Proposal, in the order to do it

**Tier A — no product change, each its own small PR.**

1. **Diff `persistEnrichment`.** Read the artist's current `artist_links` once (the same shape as
   `filterUnchangedLinks`), upsert only rows whose `url`/`source`/`is_direct` differ, and stop
   writing `last_enriched_at` unconditionally — either throttle it to hourly like
   `PERSIST_REFRESH_FLOOR_MS`, or drop the column, since nothing reads it. Unit-testable against
   the existing `db` test pattern.
2. **Drop the write-only indexes**, one migration, each guarded by the query-5 result:
   `idx_artists_updated`, `idx_artists_slug`, `idx_app_events_created` (keep the original
   `idx_app_events_created_at`; same definition), `idx_app_events_type_app` (superseded by
   `type_created` for every dashboard query; no query filters on `app` together with
   `event_type`), and `idx_releases_artist_id`. Plain `DROP INDEX`, not `CONCURRENTLY`: the CLI
   runs each migration in a transaction, where `CONCURRENTLY` is refused, and these tables are
   small enough that the lock lasts milliseconds. The `artists` drops are the one with leverage:
   they make most `artists` updates HOT.
3. **Port the web's search-event fix to the Mac app**: remove the `trackAppEvent("search")` call
   before each `searchArtist` in `AppState.swift` (four sites; keep the completion call that
   carries `has_results`). Halves the Mac app's `app_events` volume.
4. **Throttle `api_keys.last_used_at`** to once an hour: add `last_used_at` to the select in
   `authenticateApiKey` and skip the update when it's recent.

**Tier B — dials, reversible in a one-line change, product-visible.**

5. **Slow the sweep while the backlog drains**: `.github/workflows/recatalog-sweep.yml` from
   every 6 hours to every 12 (100 → 50 artists/day), or cut `MAX_DETAIL_FETCHES_PER_RUN` from
   300 to 150. New artist pages take longer to fill; alerts for *saved* artists are unaffected
   because saving still catalogues immediately.
6. **`DETAIL_REFRESH_DAYS` 30 → 90.** Prices refresh quarterly instead of monthly; the recurring
   workload drops to a third.
7. **Extension: fire `extension_activated` once per tab-session per streaming service**, not per
   track. Keep the `search` event and the per-artist `increment_analytics` calls — those are the
   ones an artist's dashboard is built on.

**Tier C — structural, needs a decision.**

8. **Bounded `app_events` with a daily rollup.** Add `app_events_daily (day, event_type, app,
   context_key, context_value, count)`, have the nightly job aggregate rows older than 90 days
   into it and *delete* them, and point the five `analytics_*` SQL functions at
   `rollup UNION raw`. Every number the dashboard shows is a count by type/app/day/platform, so
   nothing is lost; the year-over-year argument from 2026-08-08 is preserved by the rollup. The
   table stops growing, the scrub's second rewrite of every row disappears (a delete is one
   heap write and no dead-tuple churn on six indexes), and the working set shrinks. This is the
   one that turns `app_events` from an unbounded term into a constant.

## What landed (2026-09-06)

Tiers A and B, on the `claude/supabase-disk-io-optimization-ly3jne` branch, one commit each:

| # | Change | Where |
|---|---|---|
| 1 | `persistEnrichment` diffs links before writing and no longer writes `last_enriched_at` | `api/functions/db.ts`, test in `__tests__/persist-enrichment-churn.test.ts` |
| 2 | Five write-only indexes dropped | `supabase/migrations/20260906120000_drop-write-only-indexes.sql` |
| 3 | Mac app writes one `search` event per search, not two | `apps/mac/Unstream/Models/AppState.swift` |
| 4 | `api_keys.last_used_at` stamped hourly, not per request | `api/functions/middleware.ts` |
| 5 | Sweep every 12 hours (50 artists/day) | `.github/workflows/recatalog-sweep.yml` |
| 6 | `DETAIL_REFRESH_DAYS` 30 → 90 | `api/functions/catalog-artist-background.ts` |
| 7 | Extension fires `extension_activated` hourly per service, not per track | `apps/extension/background/service-worker.js` (2.7.1) |

Two of these need a release to take effect for real users: the Mac app change ships with the
next Sparkle build, and the extension change with the next store submission. The rest are live
on merge (the migration applies itself via `supabase-migrate.yml`; check that run went green).

Things deliberately *not* changed, and why:

- `idx_releases_match (artist_id, release_type, match_key)` is still there. Its middle column is
  dead weight since release type left identity, but it is still the index the match lookup
  uses; rebuilding it as `(artist_id, match_key)` is a separate, measurable change.
- The 90-day `app_events` scrub still rewrites rows. Removing that second write is Tier C — a
  rollup plus retention — and is a product decision about history.
- The sweep cadence is a dial, not a fix. The workflow comment says when to turn it back.

The measurement that says whether this was enough is the same as before: the Supabase disk I/O
graph over the two weeks after merge, and queries 2 and 5 above. If `artist_links` updates are
still climbing, something else writes them; if `releases` inserts dominate, the backlog is
still draining and the cadence is the lever.

**If the warning is urgent right now**, the no-deploy relief valve from the previous section
still stands: delete `RELEASE_CATALOG_ENABLED` from the Netlify Functions environment and pause
the sweep workflow. Everything in Tier A can then land before turning it back on.

---

# Round 5 (2026-09-13): the advisor's findings, and why the pool never drains

**Trigger:** the disk I/O budget warning returned a week after round 4 (#515) landed. This time
the owner asked Supabase's AI assistant to diagnose it. It ran `pg_stat_statements` but the
project's permission settings withheld the rows from it, so it fell back to the performance
advisor and reported three things: two missing foreign-key indexes, 22 RLS policies that call
`auth.uid()` per row, and nine unused indexes. This section checks each against the code, then
records what the sweep's own logs say about where the I/O is actually going.

## The advisor's three findings, checked

**1. Missing FK indexes on `saved_artists.artist_id` and `verification_requests.user_id`.** The
foreign keys exist (`saved_artists.artist_id` is `ON DELETE SET NULL` since migration 014;
`verification_requests.user_id` cascades from `auth.users`). But the advisor doesn't know how big
the tables are. `saved_artists` had 69 live rows with an `artist_id` on 2026-09-12 (the sweep's
`savedArtists` count) and already carries five indexes; `verification_requests` holds a handful of
rows, one per claim attempt. Either table is one or two 8 KB heap pages, so a "sequential scan" is
a single block read from a page that is always cached. The only queries filtering on those
columns are `getActiveSavers` (once per newsworthy release) and the merge tool. An index here
would be pure write cost. **Skip both.**

**2. Rewrite RLS policies to `(select auth.uid())`.** The code has 23 such policies (`saved_artists`
4, `usernames` 4, `release_feed_tokens` 4, `notification_preferences` 3, `collection_items` 3,
`listening_signals` 2, and one each on `verification_requests`, `artist_profiles`,
`artist_analytics`). The rewrite is correct Postgres advice — it turns a per-row function call
into an InitPlan evaluated once per statement. It is also irrelevant here: **no production query
runs under RLS.** Every function reads and writes through the service-role client
(`getClient()` in `db.ts`), which bypasses RLS; the anon key appears only in `middleware.ts`, and
only for `auth.getUser(token)`; there is no `supabase.from(...)` anywhere in `apps/web/src`, the
Mac app goes through the functions, and the extension's `lib/supabase.js` talks to `/auth/v1`
alone. Those policies are a backstop that has never been evaluated against a real row. Even where
they do run, per-row `auth.uid()` costs CPU, not disk. **Do it as hygiene** (one migration, no
product effect) so the advisor stops reporting it, but it changes nothing on the I/O graph.

**3. Nine unused indexes.** The advisor is right that these exist and half of them are genuinely
dead, but every table it names is small and rarely written, so the write amplification it
describes is real and negligible. From the code, per table:

| Table | Index | Verdict |
|---|---|---|
| `saved_artists` | `idx_saved_artists_user_id` | Drop — strict prefix of four other `(user_id, …)` indexes on the same table |
| `saved_artists` | `idx_saved_artists_user_artist` | Drop — built for the `(user_id, artist_id)` key migration 014 replaced; every query keys on `artist_slug` |
| `artist_merge_overrides` | `idx_merge_overrides_urls` (GIN) | Drop — `getMergeOverrides` reads the whole table into the 60-second memo; nothing queries `platform_urls` containment |
| `release_catalog_state` | `idx_release_catalog_state_catalogued` | Drop — the cooldown is evaluated in JavaScript over the whole table (`getStaleCatalogCandidates`) or per `artist_id` (`claimArtistForCatalog`). Keep `_attempted`: the hourly-cap count uses it |
| `release_feed_tokens` | `idx_release_feed_tokens_token` | Drop — `token` is `UNIQUE`, which already indexes it; the migration comment even says so |
| `email_log` | `idx_email_log_created_at` | Drop — `email_log` is insert-only from `notifications.ts`; nothing reads by date |
| `api_keys` | `idx_api_keys_prefix` | **Keep.** `authenticateApiKey` filters `key_prefix` and `is_active = true`, matching the partial index. Zero scans means zero authenticated v1 calls since the stats reset, not a dead index |
| `listening_signals` | `idx_listening_signals_user` | Keep — `me-listening` filters on `user_id`; a tiny table just makes the planner prefer a seq scan |

Confirm each with query 5 (`pg_stat_user_indexes`) before dropping. None of this moves the budget.

**The honest summary of the advisor's output:** every recommendation is correct as SQL and
targets tables measured in kilobytes. The database's I/O is where rounds 3 and 4 said it was, in
the release tables and `app_events`, and the one thing that would have shown that — the
`pg_stat_statements` ranking — is exactly what the assistant couldn't see. The owner can: the
SQL editor shows results the assistant is denied. Queries 1–5 above are the measurement.

## What the sweep logs say: the pool grows as fast as the sweep drains it

The sweep reports its selection every run. Three consecutive runs from GitHub Actions:

| Run (UTC) | `catalogueable` | `eligible` | `neverAttempted` in the batch of 25 |
|---|---|---|---|
| 2026-09-11 16:50 | 4,424 | 4,037 | 23 |
| 2026-09-12 05:17 | 4,446 | 4,070 | 21 |
| 2026-09-12 15:56 | 4,456 | 4,124 | 0 (a saved-artist batch: 25 due for their 7-day refresh) |

Two things follow.

**The pool is not static.** It was 2,564 on 2026-08-02 and 4,456 on 2026-09-12: +1,892 in 41
days, about 46 a day, and about 30 per 12 hours between the runs above. The sweep catalogues 50
a day. Round 3 estimated "a month or two" of latency for a searched artist on the assumption
that the pool was a fixed backlog to drain. It isn't, because `persistSearchResults` writes an
`artists` row and its links for every artist a search resolves, and any of them with a Bandcamp,
Discogs, Faircamp, jam.coop or Mirlo link joins the pool. **Search still decides what gets
catalogued** — it just does so through the sweep instead of the removed `searched` trigger — and
search traffic is the one input with no feedback loop to the database's capacity. That is the
same shape round 3 identified, one step removed.

**Almost every sweep slot is the expensive case.** 21–23 of 25 in a non-saved batch have never
been attempted, and a first-time catalogue is the one that inserts rows into `releases` (seven
indexes after round 4), `release_sources` and `release_offers`, and fetches up to 40 detail pages.
Round 4's diffing (`persistReleases`, `persistReleaseDetail`, `persistEnrichment`) makes a
*re*-catalogue nearly free; it cannot make a first catalogue free. So halving the cadence in
round 4 halved the write load, and the warning came back anyway, because 50 first-time catalogues
a day is still 50 first-time catalogues a day, indefinitely.

The product reasoning for the wide pool ("Why the sweep's pool isn't saved-only", engineering
history) was that `/a/:slug` renders a release list for any catalogued artist and those pages
exist because somebody searched. That is true and it is also the whole cost: cataloguing an
artist nobody has saved, claimed or imported serves a page whose main visitor is a crawler (the
CDN holds it for a day). Artists first means cataloguing where a fan is actually waiting.

## A note on the instance

The free tier is a Nano: up to 0.5 GB of memory shared between Postgres, PostgREST, Auth and the
pooler, a shared CPU, and a disk that can burst above its baseline for short periods before being
throttled back to it. The "budget" in the warning is that burst allowance. Reads that miss the
buffer cache spend it just like writes, and on 0.5 GB the buffer cache is small, so **database
size against RAM is a question in its own right** (query 1). If the release trio, `app_events`
and the trigram GIN on `artists.name` no longer fit, ordinary indexed reads become disk reads and
shrinking the working set is the fix, not just cutting writes.

## Measure first (the owner, ten minutes, no deploy)

The assistant couldn't see the rows; the SQL editor can. Before changing anything:

1. Run queries 1–5 from the sections above and paste the results into the next round of this
   document. Query 1 answers "does the database fit in memory"; query 2 answers "which tables are
   being written"; query 4 is the ranking the assistant was denied.
2. Open Reports → Database and put the Disk IO consumption graph next to the clock. Spikes at
   **01:00 and 13:00 UTC** lasting up to ten minutes are the sweep. A blip at **03:00–03:20 UTC**
   is the two `pg_cron` jobs. A raised floor that follows traffic is search-time reads and
   `app_events`. Which of those shapes the graph shows decides which tier below matters most.
3. Glance at the memory and swap graphs for the same window. Swap traffic is disk I/O.

## Proposal, in the order to do it

**Tier 1 — decouple the sweep pool from search traffic. The structural fix.**

Change `getStaleCatalogCandidates` so that a *first-time* catalogue only happens for an artist
someone has demonstrated they care about: saved by any fan, holding a claimed profile, or reached
by a collection import (that path already catalogues directly). Artists that already have a
`release_catalog_state` row stay in the pool for their refresh, so nothing catalogued so far goes
stale. Concretely the pool becomes
`(saved ∪ claimed ∪ has-state-row) ∩ catalogueable` instead of `catalogueable`. It is a
~30-line change in `db.ts` plus one more paged read of `artist_profiles`, with a unit test in the
existing `__tests__` pattern, and the sweep's summary gains a `firstTimeEligible` count so the
workflow log shows the backlog shrinking to zero.

What it costs: the `/a/:slug` page of an artist nobody has saved or claimed shows no releases,
exactly as every artist page did before 2026-07-31. Claimed artists keep their own "catalogue
now" button. If empty pages turn out to matter, the follow-up is demand by page view — add the
artist slug to the `page_view` event the web app already sends and let the sweep admit artists
viewed in the last 30 days — which is still bounded by real people opening real pages rather
than by search volume.

What it buys: first-time catalogues drop from ~50/day forever to the rate at which fans save new
artists (69 saved artists in total after four months). The sweep's steady state becomes the
cheap re-catalogue path round 4 already optimised. This is the only change in the list that turns
the write load from a function of traffic into a constant.

**Tier 2 — bound `app_events` (round 4's Tier C).**

Add `app_events_daily (day, event_type, app, context_key, context_value, count)`; have the
nightly job aggregate rows older than 90 days into it and delete them, replacing the
`session_hash` scrub UPDATE. The five `analytics_*` functions read `rollup UNION raw`. Every
dashboard number is a count by type/app/day/platform, so nothing the dashboard shows is lost, and
the row-level history older than 90 days was already anonymous (the scrub nulled the only
per-visitor field). Turns the one table with no retention into a constant-size working set and
ends the second rewrite of every row it has ever received. This is the change that matters if
query 1 says the database no longer fits in memory.

**Tier 3 — the advisor's hygiene, one migration, zero product effect.**

Rewrite the 23 `auth.uid()` policies to `(select auth.uid())`; drop the six indexes marked
"Drop" in the table above once query 5 confirms `idx_scan = 0`; leave the two FK indexes
un-added, with this section as the reason. Plain `DROP INDEX`, not `CONCURRENTLY`, for the same
reason as round 4's migration. Worth doing so the next diagnosis isn't cluttered with findings
that don't matter, and it is the only part of the assistant's output that adds anything.

**Tier 4 — only if the measurements point at it.**

- `idx_releases_match (artist_id, release_type, match_key)` → `(artist_id, match_key)`, since
  release type left identity on 2026-08-29. One fewer wide index on the hottest insert table.
- If query 3 shows `heap_blks_read` dominating on `releases`/`release_sources`: the artist page's
  nested `releases → release_sources → release_offers` select with `count: 'exact'` is the read to
  look at, though the CDN's one-day cache already bounds it to ~800 pages a day.

**The relief valve is unchanged:** delete `RELEASE_CATALOG_ENABLED` from the Netlify Functions
environment and disable the sweep workflow's schedule. Everything above can land with the tap
off and the tap turned back on afterwards.

## What this round asked the owner to decide, and the answer

One thing: whether an artist page for an artist nobody has saved or claimed may show no
releases. The owner's reasoning, 2026-09-13: most searches are for large artists whose
discography is a click away on Bandcamp or Qobuz, so there is little value in mirroring it;
the release pages earn their keep for small, claimed artists promoting their own work as an
alternative to Linktree, Odesli or a distributor's smart links. The scraper was built to compete
with Odesli and for SEO and hasn't demonstrably done either. So: yes.

## What landed (2026-09-13)

Tiers 1 and 3, on `claude/unstream-disk-io-optimization-z7qp1x`:

| # | Change | Where |
|---|---|---|
| 1 | `getStaleCatalogCandidates` builds a first catalogue only for saved, claimed or collected artists; already-catalogued artists keep refreshing; the rest are counted as `awaitingDemand` | `api/functions/db.ts`, tests in `__tests__/recatalog-sweep-selection.test.ts` |
| 1 | The sweep summary gains `claimedArtists`, `collectedArtists`, `awaitingDemand` | `api/functions/recatalog-sweep.ts`, workflow comment |
| 3 | 23 RLS policies rewritten to `(select auth.uid())`; six dead indexes dropped; the two FK indexes deliberately not added | `supabase/migrations/20260913120000_rls-initplan-and-dead-indexes.sql` |

Two refinements to the Tier 1 proposal above, found while implementing it:

- **Collections are a third kind of demand.** `resolveCollectionArtists` asks for only the
  first 25 artists of a sync directly and relies on the sweep for the rest (its own comment
  says so). Without `collection_items.artist_slug` in the demand set those artists would have
  sat in `awaitingDemand` forever and the gap report would have quietly stopped filling in.
- **A state row with only failures is "never catalogued".** An unsaved artist whose every
  attempt failed has nothing stored to keep fresh, so they leave the pool too, instead of being
  retried for nobody on an exponential backoff.

The selection now costs four paged reads plus one `in()` per hundred distinct collection slugs,
twice a day — still a rounding error next to one first-time catalogue.

What to watch: the sweep log's `awaitingDemand` should be most of the pool and may grow with
traffic, which is fine; `eligible` should fall to the few hundred saved, claimed, collected and
previously-catalogued artists; and the Supabase disk I/O graph over the following two weeks is
the measurement. If it still doesn't settle, the next dial is to stop refreshing artists with
no demand signal (drop the `last_catalogued_at` clause from the gate), and after that Tier 2.
The migration applies itself via `supabase-migrate.yml` on merge; check that run went green, and
run query 5 afterwards to confirm the dropped indexes were the zero-scan ones.

---

# Round 6 (2026-09-19): the measurement pack

**Trigger:** the instance wedged. On 2026-09-19 the database was up with TCP 5432 open but
PostgREST never answering — artist profiles and search unusable for hours — until a compute
restart brought it back (slow recovery is normal on nano; services return one by one, Realtime
first). Diagnosis: sustained disk I/O pressure, i.e. the failure mode this document's round 5
"note on the instance" predicted — once the working set outgrows the tiny buffer cache,
ordinary indexed reads become disk reads, and an I/O-throttled Postgres accepts connections but
can't answer queries. The Supabase status page also carried a recent "Unresponsive Nano
projects" incident, so platform flakiness on nano is real too; sustained pressure raises our
susceptibility to it either way.

Timeline markers, from the sweep's own Actions history:

| Run | Scheduled (UTC) | Result |
|---|---|---|
| 35310764343 | 2026-09-18 05:25 | success |
| 35370905703 | 2026-09-18 16:51 | success — last healthy run |
| 35423732838 | 2026-09-19 05:21 | **failure** — the wedge marker; the sweep was a victim, not the trigger |

This round lands two structural changes and this measurement pack, which is the pre/post
measurement for both: the `app_events` daily rollup with 90-day retention (round 4 Tier C /
round 5 Tier 2), and demand-gating the catalog *refresh* (round 5's named next dial). Run the
pack before merging them, and again two weeks after. The arbiter is the Supabase Disk IO graph
over those two weeks.

## The pack

Paste the whole block into the Supabase SQL editor, or run it from a checkout of this repo with
`supabase db query --linked --output json -f <file>.sql` (must be run from the repo root, where
`supabase/config.toml` lives, and each statement separately — the CLI returns one result set per
call; that is how the baseline below was taken). `pg_stat_statements` is enabled by default;
if query 4 errors, skip it and rely on the rest. All `pg_stat_*` counters are **cumulative since
stats were last reset**, not a window — so paste today's numbers into this document, and the
two-week comparison is the diff against them.

```sql
-- 1. Biggest tables, and how much of that is indexes.
-- Both views expose relname/relid, so every reference is alias-qualified; a bare `relname`
-- here is ambiguous and errors.
SELECT s.relname AS table,
       pg_size_pretty(pg_total_relation_size(s.relid))                             AS total,
       pg_size_pretty(pg_relation_size(s.relid))                                   AS heap,
       pg_size_pretty(pg_total_relation_size(s.relid) - pg_relation_size(s.relid)) AS indexes,
       t.n_live_tup AS live_rows
FROM pg_catalog.pg_statio_user_tables s
JOIN pg_stat_user_tables t USING (relid)
ORDER BY pg_total_relation_size(s.relid) DESC
LIMIT 20;

-- 2. Write volume and vacuum pressure per table since stats were last reset.
SELECT relname AS table,
       n_tup_ins AS inserts, n_tup_upd AS updates, n_tup_del AS deletes,
       n_dead_tup AS dead_rows,
       autovacuum_count, autoanalyze_count,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC
LIMIT 20;

-- 3. Reads that missed the cache and went to disk.
SELECT relname AS table,
       heap_blks_read AS heap_disk_reads, heap_blks_hit AS heap_cache_hits,
       idx_blks_read  AS idx_disk_reads,  idx_blks_hit  AS idx_cache_hits
FROM pg_statio_user_tables
ORDER BY (heap_blks_read + idx_blks_read) DESC
LIMIT 20;

-- 4. The statements doing the most block I/O.
SELECT calls,
       round(total_exec_time::numeric, 0) AS total_ms,
       shared_blks_read  AS disk_reads,
       shared_blks_dirtied AS blocks_dirtied,
       shared_blks_written AS blocks_written,
       left(query, 160) AS query
FROM pg_stat_statements
ORDER BY (shared_blks_read + shared_blks_dirtied) DESC
LIMIT 25;

-- 5. Index size and how often each has been used since stats were reset.
SELECT s.relname AS table, s.indexrelname AS index,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       s.idx_scan AS scans,
       i.indisunique AS is_unique
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
ORDER BY s.relname, s.idx_scan;
```

What each answers, and which result confirms which diagnosis:

| # | What it answers | Confirms | Refutes |
|---|---|---|---|
| 1 | Does the database fit in memory? Total size against 0.5 GB of shared RAM. | `releases` + `release_sources` + `release_offers` and `app_events` at the top — the working set is the round 5 "note on the instance" failure mode, and the wedge is that made acute. | Small totals — then the wedge was platform flakiness, and shrinking tables buys nothing. |
| 2 | Which tables are being written? | The `releases` trio dominating `inserts`; `app_events` dominating `inserts` with a `n_tup_upd` bump matching the scrub's nightly rewrite. | `artist_links` high in `updates` — that would mean enrichment churn came back (round 4 §2's diff fix regressed). |
| 3 | Which tables no longer fit the buffer cache? | Large `heap_blks_read`/`idx_blks_read` next to small `hit` counts on the big tables — reads are now disk reads, the wedge's mechanism. | High hit ratios everywhere — reads aren't the term; look at query 4 for a write-side statement instead. |
| 4 | Which statements move the disk? The ranking round 5's advisor was denied. | The sweep's inserts/updates and the dashboard's aggregates near the top. | Search-time statements dominating — then the fan-out reads are the term, and the rollup/retention is the right lever anyway. |
| 5 | Which indexes earn their writes? `idx_scan = 0` on a non-unique index is a drop candidate. | See the round 5 follow-ups below. | — |

## Reading the graphs

Reports → Database, Disk IO consumption graph next to the clock:

- **Spikes at 01:00 and 13:00 UTC** (up to ten minutes, twice daily) are the release catalogue
  sweep (`recatalog-sweep.yml`, every 12 hours since round 4).
- **A blip around 03:00–03:20 UTC** is the two nightly `pg_cron` jobs — the saved-artists
  tombstone GC at 03:00 and the `app_events` job at 03:20.
- **A raised floor that follows traffic** is search-time reads plus `app_events` inserts. Which
  of those shapes the graph shows decides which lever matters most.
- Open the **memory and swap graphs for the same window**: swap traffic *is* disk I/O.

## The Sep 18–19 window specifically

The wedge is timestamped, so compare this window rather than the general shape: from the last
healthy sweep at **16:51 UTC Sep 18** to the restart on **Sep 19**. The failed **05:21 UTC**
sweep run is the marker inside it. Look for:

- The Disk IO floor rising through Sep 18's evening (UTC) rather than returning to baseline
  after each sweep spike — sustained pressure, not bursts.
- I/O **pinned at a flat baseline rate** for hours before the wedge: that is what throttling
  looks like once the burst allowance is spent, and it reads as "quiet" if you only glance for
  spikes.
- Memory climbing across the window and swap-in/swap-out traffic appearing before 05:21 — the
  buffer cache losing and the instance starting to page.

## Round 5 follow-ups, same sitting

- **Query 5:** the six indexes round 5 dropped should no longer appear at all —
  `idx_saved_artists_user_id`, `idx_saved_artists_user_artist`, `idx_merge_overrides_urls`,
  `idx_release_catalog_state_catalogued`, `idx_release_feed_tokens_token`,
  `idx_email_log_created_at` — while the two deliberately kept (`idx_api_keys_prefix`,
  `idx_listening_signals_user`) do. Their absence plus the kept pair is the confirmation; the
  drops themselves can't be re-measured once gone.
- **The sweep logs:** open the recent `Release catalogue sweep` runs in Actions (the table above
  lists the IDs) and read the `Sweep OK: {…}` line of each. Round 5 gated only *first*
  catalogues, so `eligible` does **not** fall to the few hundred saved/claimed/collected artists —
  the ~4,000 artists catalogued before that gate stay in the refresh pool forever, which is
  exactly the premise of this round's refresh demand-gate. What to expect instead:
  `awaitingDemand` growing (that growth is search traffic, and is fine), and the
  previously-catalogued bulk sitting in `eligible`. `catalogueable` collapsing, or `eligible`
  at 0 while `inCooldown` and the saved/claimed/collected counts don't explain it, still means
  a broken selection. The measured numbers are in the baseline below.

## The baseline (2026-09-19, pre-merge)

Taken with the CLI route above at ~13:00 UTC, before the rollup (#524) and the refresh
demand-gate (#523) merged — the "pre" half of the pre/post comparison; rerun the pack two
weeks after both land and diff against this.

**The counters were reset by the Sep 19 compute restart.** Every table shows
`autovacuum_count = 0` and the whole `app_events` insert count since reset is 107, so all
cumulative numbers below measure *from the restart onward* — a clean origin, better than a
mid-life baseline would have been, but it means `idx_scan` and write counts carry only a few
hours of history and `n_live_tup` estimates are unreliable until an analyze runs. Treat
"zero scans" as "not used since the restart", not "never used".

**Query 1 — the whole database is 98 MB.** That lands in the pack's *refutes* column: small
totals mean the wedge leans platform flakiness over working-set pressure, and shrinking
tables buys little I/O. The two structural changes remain worth their other benefits
(retention, a bounded sweep), but the Disk IO graph for the Sep 18–19 window is what actually
settles the wedge's cause.

| Table | Total | Heap | Indexes |
|---|---|---|---|
| app_events | 20 MB | 11 MB | 9312 kB |
| releases | 18 MB | 8384 kB | 9912 kB |
| release_sources | 14 MB | 6560 kB | 7784 kB |
| artist_links | 13 MB | 8936 kB | 4672 kB |
| release_offers | 9576 kB | 4952 kB | 4624 kB |
| artists | 3512 kB | 1672 kB | 1840 kB |

`app_events` specifics for the rollup: **61,675 rows, 10,779 already past 90 days** (oldest
2026-04-12), so the first night's rollup moves ~11k rows and every row after that is
write-once.

**Query 2 (write volume, since the restart):** `app_events` 107 inserts and `artist_analytics`
85 lead, then `artist_links` 28 ins / 5 upd / 28 del — nothing like the volumes round 4
measured, consistent with a fresh counter. Re-read in two weeks for the real comparison.

**Query 3 (cache hits):** healthy ratios on the big tables — `releases` 287k hits vs 1k disk
reads, `artist_links` 104k vs 1.1k. The weakest are `app_events` (~2:1) and
`bandcamp_slug_probes` (~1:1, but it is a cache table read mostly on misses by design).

**Query 4 (statements):** the top block-I/O statements are the release/`artist_links` reads
that back search and artist pages (one at 42 calls / 23s total / 1098 disk reads), with the
`app_events` INSERT path the largest block-*dirtier* (99 dirtied across 108 calls). The
sweep's writes had not run since the restart at capture time.

**Query 5 (indexes):** the round 5 confirmation holds — none of the six dropped indexes
appear, and both deliberately-kept ones (`idx_api_keys_prefix`, `idx_listening_signals_user`)
are present. `idx_app_events_unscrubbed` (1320 kB, the scrub's partial index) is still there
with zero scans — #524's migration drops it, which is that PR's reclaim visible in advance.

**The sweep logs (round 5 follow-up, corrected):** `eligible` did *not* fall to a few
hundred — it sits at ~4,000, because round 5 gated only first catalogues and the
pre-gate-catalogued artists keep refreshing. `awaitingDemand` grows at ~18/day, which is the
search-traffic shape the pack predicted:

| Run (UTC) | catalogueable | awaitingDemand | eligible | inCooldown |
|---|---|---|---|---|
| 09-14 18:17 | 4558 | 166 | 4087 | 305 |
| 09-15 05:36 | 4566 | 174 | 4082 | 310 |
| 09-15 17:25 | 4569 | 177 | 4092 | 300 |
| 09-16 05:31 | 4584 | 192 | 4067 | 325 |
| 09-16 17:23 | 4595 | 203 | 4067 | 325 |
| 09-17 05:37 | 4602 | 210 | 4067 | 325 |
| 09-17 17:23 | 4629 | 237 | 4067 | 325 |
| 09-18 05:25 | 4641 | 249 | 4042 | 350 |
| 09-18 16:51 | 4650 | 258 | 4047 | 345 |
| 09-19 05:21 | — (failed — the wedge; see the run table above) | | | |

(`savedArtists` 69 and `claimedArtists` 134 are flat throughout; `collectedArtists` 0.)

**The post-merge observable, then:** once #523 lands, the first sweep's `eligible` should
collapse to roughly the saved/claimed/collected few hundred, and the new `frozenCatalogues`
count should jump to the ~4,000 this baseline shows leaving the refresh pool. If `eligible`
stays in the thousands, the gate didn't take.
