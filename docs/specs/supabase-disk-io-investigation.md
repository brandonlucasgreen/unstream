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
