-- Migration: delete the stored `subvert.fm/discover` placeholder links
--
-- Exactly the defect 20260803120000 cleared for Bandcamp, on a platform that was missed. Subvert
-- is `searchOnly: true` in apps/web/src/services/sources.ts and its `searchUrlTemplate` is
--
--   https://www.subvert.fm/discover?q={query}&type=artist
--
-- so every Subvert link the search pipeline ever stored is that search box with the query
-- substituted in. `isDirectLink` did not list it, so the rows passed the one gate that decides
-- whether a link gets stored at all. Fixed in the same PR as this migration.
--
-- Why they are worth deleting rather than leaving in place: on `/a/:slug` and in search results
-- they render as a platform the artist is on, and downstream they are indistinguishable from a
-- real Subvert artist page. They also make the "Artists You Know" index overclaim — Subvert is a
-- marketplace, so a placeholder counts as "has music available for direct purchase" when nothing
-- was ever found.
--
-- Measured immediately before writing this migration: 349 Subvert links stored, of which
--
--   * 321 match `subvert.fm/discover` and all carry `source = 'search'`
--   * 28 are real `subvert.fm/<handle>` artist pages and all carry `source = 'claimed'`
--
-- so the split is clean and no artist-curated row is touched. No artist is left with zero links:
-- every affected artist keeps at least one other platform.
--
-- Scoped by URL shape, not by platform, for that reason — a real Subvert artist page has no
-- `/discover` path, and dropping the platform outright would delete the 28 links artists added
-- themselves.
--
-- Idempotent: re-running deletes nothing, because isDirectLink now rejects this shape.

DELETE FROM public.artist_links
WHERE platform = 'subvert'
  AND url ILIKE '%subvert.fm/discover%';
