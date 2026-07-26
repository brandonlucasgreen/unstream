-- Migration 026: Cache the location string alongside each Bandcamp probe (UNS-152)
--
-- The probe fetches <slug>.bandcamp.com/music, and that same response already
-- carries the artist's location in a class="location" element (~90% of the time).
-- Storing it here means a cache hit yields the URL *and* the location, so the
-- enrichment path no longer needs a second request to a page we already read.
--
-- Nullable: artists whose page shows no location keep NULL, which is also what
-- Bandcamp's own discover API reports for them.

ALTER TABLE public.bandcamp_slug_probes
  ADD COLUMN IF NOT EXISTS location TEXT;

COMMENT ON COLUMN public.bandcamp_slug_probes.location IS
  'Raw location string from the probed /music page, e.g. "Oxford, UK". NULL when the page shows none (UNS-152).';
