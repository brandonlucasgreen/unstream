-- Migration: release_sources.detail_checked_at
--
-- Records when we last read a release's own page for its date, formats and prices.
--
-- The `/music` grid gives identity and artwork for a whole discography in one request but
-- carries no dates, formats or prices at all — those exist only on individual release pages,
-- at one request each. So the detail pass is metered, and it needs to know two things the
-- rest of the schema can't tell it:
--
--   1. Which releases have never been read, so a bounded run can pick up where the last one
--      stopped instead of re-reading the same newest few forever.
--   2. Which were read long enough ago to be worth re-reading. Prices change and vinyl sells
--      out; an offer is a claim with an age, not a fact.
--
-- Why not infer it from `releases.release_date IS NULL`: a standalone track page legitimately
-- has a date and no offer, and plenty of releases have a date from the grid-era rows that
-- predate this column. Inferring would re-fetch those every cycle and never converge.

ALTER TABLE release_sources
  ADD COLUMN IF NOT EXISTS detail_checked_at timestamptz;

COMMENT ON COLUMN release_sources.detail_checked_at IS
  'When this source''s own release page was last read for date/formats/prices. NULL means never. Drives both the initial detail pass and offer-freshness refresh.';

-- Observability for the detail pass, beside the grid pass's own count.
--
-- These two numbers fail independently and for different reasons: the grid can parse fine
-- while every release page returns a bot challenge, which shows up as releases_found = 20 and
-- releases_detailed = 0. Without the second number that reads as a healthy run, and the
-- symptom a fan sees — release pages with no prices on them — has no signal behind it.

ALTER TABLE release_catalog_state
  ADD COLUMN IF NOT EXISTS releases_detailed integer;

COMMENT ON COLUMN release_catalog_state.releases_detailed IS
  'Release pages successfully read for date/formats/prices in the last run. Much lower than releases_found is expected (the pass is budgeted); zero across many runs is a failure.';
