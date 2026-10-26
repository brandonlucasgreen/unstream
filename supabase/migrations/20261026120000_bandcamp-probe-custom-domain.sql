-- Record when a probed Bandcamp account sits behind the artist's own custom domain
--
-- A Bandcamp Pro artist can put their own domain in front of their account
-- (music.zoekeating.com is a CNAME to dom.bandcamp.com). For a server-side request,
-- <slug>.bandcamp.com/music then redirects to that domain and the domain redirects
-- straight back, forever; a browser gets the page. Every such artist used to come back
-- 'undecided' from the probe — never cached, so each search re-ran the loop — and was
-- missing from search whenever MusicBrainz didn't list their Bandcamp.
--
-- The probe now reads two pages that don't loop instead: /community (band name for the
-- identity check, photo, location) and /sitemap.xml (release count and titles), and
-- stores the custom domain here. Those rows have no bio: it is only on the pages that
-- loop. They are written with bio '' (nothing to read on the pages we can reach) so the
-- NULL-bio re-probe in findBandcampArtist doesn't retry them on every search.
--
-- NULL = an ordinary account, or a row written before this column existed.
--
-- RLS unchanged: bandcamp_slug_probes is server-only (RLS enabled, no policies).

ALTER TABLE public.bandcamp_slug_probes
  ADD COLUMN IF NOT EXISTS custom_domain TEXT;

COMMENT ON COLUMN public.bandcamp_slug_probes.custom_domain IS
  'Hostname the account redirects to (e.g. music.zoekeating.com) when it sits behind a Bandcamp Pro custom domain; NULL otherwise. Such rows were read from /community and /sitemap.xml, not /music.';
