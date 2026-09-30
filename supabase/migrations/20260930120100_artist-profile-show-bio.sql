-- Let a claimed artist turn off the bio shown on search and detection results
-- (docs/specs/artist-bio-excerpt-spec.md, decided 2026-09-30)
--
-- Search shows a short bio under an artist's name: their own Unstream bio if they wrote one,
-- otherwise one found on Bandcamp, Discogs or Wikipedia. Some artists will want no bio at
-- all rather than a third party's version of them. With show_bio = false search shows none,
-- and does not fall through to another source.
--
-- NOT NULL DEFAULT true: every existing profile keeps today's behaviour.
--
-- RLS unchanged. artist_profiles already has its policies, and every write to this column
-- goes through artist-profile.ts, which checks ownership with the service-role client.

ALTER TABLE public.artist_profiles
  ADD COLUMN IF NOT EXISTS show_bio BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.artist_profiles.show_bio IS
  'False when the artist turned off the search-result bio. No fallback to Bandcamp, Discogs or Wikipedia then.';
