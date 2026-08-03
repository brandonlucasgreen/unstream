-- Migration: clear the backoff left behind by the Bandcamp search-placeholder 404s
--
-- These artists were never crawlable in the first place. Their stored `bandcamp` link was
-- `https://bandcamp.com/search?q=<name>` — the "go search Bandcamp yourself" placeholder that
-- `attachAmpwallAndSearchLinks` writes when nothing resolved a real artist page. It is a UI
-- affordance, not an artist link, and `bandcampMusicUrl()` reduces any URL to its origin plus
-- `/music`, so every one of them derived `https://bandcamp.com/music` — a hard 404, every time.
--
-- Measured 2026-08-03: 189 such link rows (10.4% of all 1,822 stored Bandcamp links), and the
-- 18 that the sweep had reached by then were the **only** failures in `release_catalog_state` —
-- "bandcamp responded 404" was the sole error message in the entire table. #406 had just widened
-- the sweep to all 2,564 catalogue-able artists every 6 hours, so the remaining ~171 were queued
-- to fail the same way, each burning a batch slot and climbing a backoff it could never escape.
--
-- The code fix (this PR) stops the placeholder ever reaching the crawler: `isCatalogueableLink`
-- in `api/functions/db.ts` filters it out of both `getStaleCatalogCandidates`'s pool and
-- `getArtistForCatalog`'s result, so the two cannot disagree about who is worth a run. This
-- migration only cleans up the damage already recorded — without it, the artists who *do* have a
-- real Discogs, Faircamp or jam.coop link would keep serving out an exponential backoff earned
-- entirely by a link we will no longer even look at.
--
-- Resetting the counter rather than deleting the row: `consecutive_failures` is what
-- `claimArtistForCatalog` exponentiates (`2^min(failures,6) × 15min`, measured against
-- `last_attempted_at`), so zeroing it clears the backoff completely while `last_attempted_at`
-- survives as the audit trail of when we tried. No release, source or link row is touched.
--
-- Scoped as narrowly as the bug:
--
--   * `last_error` is exactly the 404 message — nothing else is in scope.
--   * `last_catalogued_at IS NULL` — an artist who ever catalogued successfully has a real
--     Bandcamp presence, so a later 404 from them is a genuine dead link and its backoff is
--     doing its job. All 18 rows measured had never succeeded.
--
-- Idempotent: the WHERE clause stops matching once `last_error` is null, so re-running is a
-- no-op. This queues nothing — the next scheduled sweep picks these artists up normally.

UPDATE public.release_catalog_state
SET
  consecutive_failures = 0,
  last_error = NULL,
  updated_at = now()
WHERE
  last_error = 'bandcamp responded 404'
  AND last_catalogued_at IS NULL;
