-- Migration: trigram index for the identity-URL lookup on artist_links.
--
-- findArtistSlugByIdentityUrl (api/functions/db.ts) runs before a search mints a new artist row,
-- to catch an artist we already hold under another spelling ("Big Thief" / "Bigthief"). It asks
-- for `platform IN (...) AND (url ILIKE '%host/path%' OR ...)`. artist_links has no index on
-- either column, so every new artist a search persists costs a sequential scan of the whole table
-- (~9 MB of heap on 2026-09-19), awaited before the search response goes out.
--
-- A trigram index serves `ILIKE '%…%'` (the same technique as idx_artists_name_trgm). It is
-- partial, covering only the identity platforms the lookup queries — a few thousand rows rather
-- than every social and patronage link — so it stays small and adds no write cost to the links
-- that never take part in the lookup.
--
-- The predicate must stay identical to IDENTITY_PLATFORMS in db.ts. If the code queries a platform
-- outside it, Postgres can no longer prove the query is covered and falls back to the sequential
-- scan: nothing breaks, it is just slow again.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the CLI runs each migration in a transaction, where
-- CONCURRENTLY is refused, and the build over a few thousand rows holds its lock for well under a
-- second. pg_trgm is already installed (20260729071000_artist-name-trgm.sql).
--
-- No RLS change: no new table or column, and artist_links is read through the service-role client.

create extension if not exists pg_trgm;

create index if not exists idx_artist_links_identity_url_trgm
  on artist_links using gin (url gin_trgm_ops)
  where platform in (
    'bandcamp', 'mirlo', 'jamcoop', 'faircamp', 'discogs', 'beatport', 'bandwagon', 'subvert',
    'even', 'nina'
  );
