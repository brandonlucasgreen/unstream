-- Migration 028: Cache the artist photo alongside each Bandcamp probe (UNS-152)
--
-- The artist image on a search result has been coming from the Qobuz match
-- (`qobuzMatches` carries an imageUrl). Qobuz's search path turns out to be
-- Disallow'ed in its robots.txt and is being retired, so results would otherwise lose
-- their photos entirely.
--
-- Bandcamp is the replacement source: the /music page the probe already fetches carries
-- the band photo in its og:image. Verified band-level rather than album art —
-- radiohead/music yields f4.bcbits.com/img/0040867508_23.jpg, which is exactly the
-- image production already displays for Radiohead.
--
-- Nullable: artists whose page shows no photo, and rows probed before this column
-- existed. Callers treat NULL as "no image" rather than refetching.

ALTER TABLE public.bandcamp_slug_probes
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN public.bandcamp_slug_probes.image_url IS
  'Artist photo (og:image) from the probed /music page. Replaces Qobuz as the artist image source (UNS-152).';
