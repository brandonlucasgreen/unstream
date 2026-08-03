-- Migration: delete the stored `bandcamp.com/search` placeholder links
--
-- These rows are the "go search Bandcamp yourself" fallback that `attachAmpwallAndSearchLinks`
-- used to synthesise when nothing resolved a real artist page. The fallback is removed in this
-- PR, so nothing produces them any more; this clears the ones already stored.
--
-- Why they are worth deleting rather than leaving in place:
--
--   * They claim a Bandcamp presence we never found. On `/a/:slug` and in search results they
--     render as a platform the artist is on.
--   * Stored as an ordinary `bandcamp` link, they are indistinguishable from a real artist page
--     downstream. #407 had to teach the release crawler to skip them, because it was deriving
--     `/music` from each one and getting a 404 every time — 18 artists, and the only error
--     message present anywhere in `release_catalog_state`.
--
-- Measured immediately before writing this migration: 189 rows, **all** with `source = 'search'`
-- (no artist-curated `claimed` rows among them, so nothing here is somebody's own edit), and
-- every affected artist keeps at least one other link — 0 would be left with none. #407's
-- migration already cleared their catalogue backoff, so no state rows need touching here.
--
-- Scoped by URL shape rather than by platform alone: a real `*.bandcamp.com` artist page must
-- survive. `bandcamp.com/search` cannot appear in one — an artist page lives on a subdomain or
-- a Bandcamp Pro custom domain, never on the apex with a `/search` path.
--
-- Idempotent: re-running deletes nothing, because the fallback that created these is gone.

DELETE FROM public.artist_links
WHERE platform = 'bandcamp'
  AND url ILIKE '%bandcamp.com/search%';
