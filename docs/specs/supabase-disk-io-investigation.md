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
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(relid))                             AS total,
       pg_size_pretty(pg_relation_size(relid))                                   AS heap,
       pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid))   AS indexes,
       n_live_tup AS live_rows
FROM pg_catalog.pg_statio_user_tables
JOIN pg_stat_user_tables USING (relid)
ORDER BY pg_total_relation_size(relid) DESC
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
   `type_created` for every dashboard query; confirm no query filters on `app` first), and
   `idx_releases_artist_id`. Use `DROP INDEX CONCURRENTLY` so the migration doesn't lock the
   tables. The `artists` drops are the one with leverage: they make most `artists` updates HOT.
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

**If the warning is urgent right now**, the no-deploy relief valve from the previous section
still stands: delete `RELEASE_CATALOG_ENABLED` from the Netlify Functions environment and pause
the sweep workflow. Everything in Tier A can then land before turning it back on.
