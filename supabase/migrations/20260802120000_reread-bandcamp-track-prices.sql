-- Migration: let the Bandcamp track-page price fix actually take effect
--
-- A parser fix is deployed but **inert** until whatever guards re-reading is cleared. The detail
-- pass only re-reads a source whose `detail_checked_at` is null or older than 30 days, and every
-- affected row was stamped during the first production catalog runs — so without this the fix
-- would sit dead until roughly 2026-08-31 and the pages would keep saying "No formats listed on
-- this page" for a month.
--
-- What was wrong: `parseBandcampReleaseDetail` only read a *top-level* `albumRelease`, which
-- standalone `/track/` pages don't have — theirs lives at `inAlbum.albumRelease`. Measured at the
-- time of the fix: 184 of 777 detail-read Bandcamp sources had zero offers, and 183 of those 184
-- were `/track/` URLs (every single one of the 533 sources *with* offers was an `/album/` URL).
-- The data was always published; we were looking in the wrong place.
--
-- Clearing the stamp rather than deleting anything: `detail_checked_at` is the only thing being
-- reset, so no offer, price or release row is touched. Re-reads then happen gradually through the
-- normal budgeted detail pass (100 requests per invocation, ~1/sec, and only for artists that get
-- catalogued again), not as a burst — this queues work, it does not perform it.
--
-- Scoped as narrowly as the bug: Bandcamp only, `/track/` URLs only, and only rows that have
-- actually been read and came back with **no offers at all**. A track page that already produced
-- an offer was never affected and is left alone.

UPDATE public.release_sources AS rs
SET detail_checked_at = NULL
WHERE rs.platform = 'bandcamp'
  AND rs.url LIKE '%/track/%'
  AND rs.detail_checked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.release_offers ro WHERE ro.release_source_id = rs.id
  );
