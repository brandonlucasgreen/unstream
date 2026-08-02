-- Migration: allow 'scheduled' as a release-catalog trigger
--
-- Until now every catalog attempt was demand-driven — a fan saved an artist, or someone
-- searched them. That left a hole the release-alerts feature falls straight into: an artist
-- who is saved but never searched is catalogued once and then never again, so their new
-- releases are never discovered and their alerts silently stop. A scheduled sweep
-- (`recatalog-sweep`) now re-crawls the stalest saved artists, and this is the trigger label
-- it stamps.
--
-- It gets its own label rather than reusing 'saved' for two reasons:
--
--   1. Budget. CATALOG_HOURLY_CAP in api/functions/db.ts is keyed by trigger, so a separate
--      label lets the sweep have a ceiling of its own — higher than search (so a busy hour of
--      searches can't starve it) and lower than saving (so it can never outrun a person
--      deliberately following an artist).
--   2. Observability. `last_trigger = 'scheduled'` is how you tell, from the table alone,
--      whether the sweep is still running. A sweep that quietly stops working recreates the
--      exact bug it was built to fix, so being able to see it matters.
--
-- No new index: the sweep's candidate query reads saved_artists (a few thousand rows at most)
-- and looks up their catalog state by primary key. Both are cheap at this size, and an index
-- added speculatively is one more thing to keep true.

ALTER TABLE release_catalog_state
  DROP CONSTRAINT IF EXISTS release_catalog_state_last_trigger_check;

ALTER TABLE release_catalog_state
  ADD CONSTRAINT release_catalog_state_last_trigger_check
  CHECK (last_trigger IN ('saved', 'searched', 'scheduled'));

COMMENT ON COLUMN release_catalog_state.last_trigger IS
  'What triggered the most recent attempt: a save, a search, or the scheduled sweep. Each has its own hourly ceiling.';
