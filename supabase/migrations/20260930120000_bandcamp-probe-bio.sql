-- Cache the artist's own Bandcamp bio alongside each probe
-- (docs/specs/artist-bio-excerpt-spec.md)
--
-- The /music page the probe already fetches carries the band sidebar, bio included, so
-- storing it here costs no extra request and no extra write: it rides the upsert the
-- probe makes anyway.
--
-- '' and NULL mean different things, and the difference is load-bearing:
--   ''   the page was read and shows no bio
--   NULL the row was written before this column existed — never checked
-- Accepted rows never expire, so findBandcampArtist re-probes an accepted row with NULL bio
-- once, keeping the old row if the re-probe can't answer. Collapsing the two would either
-- leave the most-searched artists without a bio forever or re-probe them on every search.
--
-- RLS unchanged: bandcamp_slug_probes is server-only (RLS enabled, no policies).

ALTER TABLE public.bandcamp_slug_probes
  ADD COLUMN IF NOT EXISTS bio TEXT;

COMMENT ON COLUMN public.bandcamp_slug_probes.bio IS
  'Artist sidebar bio from the probed page, plain text. Empty string = checked, none shown; NULL = row predates bio caching.';
