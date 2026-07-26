-- Migration 027: Cache Bandcamp release titles alongside each probe (UNS-152)
--
-- The probe fetches <slug>.bandcamp.com/music, which is the same page
-- getBandcampReleaseTitles fetches during disambiguation. Storing the titles here
-- lets that step reuse them instead of re-requesting a page we already read.
--
-- This is not just a saving. fetchReleasesForDisambiguation runs all its release
-- fetches inside a fixed 4s race, so once Phase 1 started returning Bandcamp results
-- the extra Bandcamp requests crowded out the Qobuz ones. Qobuz then arrived with no
-- release data, removeDeadQobuzLinks dropped it, and because Qobuz is where the
-- artist image comes from, the artist photo disappeared with it.
--
-- Normalized titles (via normalizeForComparison) since every consumer compares them
-- normalized. Nullable: absent for rows probed before this column existed, and the
-- caller falls back to fetching in that case.

ALTER TABLE public.bandcamp_slug_probes
  ADD COLUMN IF NOT EXISTS release_titles TEXT[];

COMMENT ON COLUMN public.bandcamp_slug_probes.release_titles IS
  'Normalized release titles from the probed /music page, reused during disambiguation so Qobuz release fetches are not starved of the shared 4s budget (UNS-152).';
