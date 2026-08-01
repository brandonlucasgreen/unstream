-- Migration: releases.flagged_against_release_id
--
-- The tier-3 fuzzy dedup pass (persistDiscogsReleases) sets `needs_review = true` on both
-- sides of a suspected duplicate pair, but never recorded *which* other release triggered the
-- flag — so an admin queue built on `needs_review` alone could show that a release was flagged
-- without being able to show what it was flagged against, forcing a re-run of the fuzzy match
-- just to reconstruct a fact ingest already knew when it wrote the flag.
--
-- Nullable, self-referencing, and best-effort: `ON DELETE SET NULL` rather than a hard block,
-- because deleting one side of a pair (e.g. via the admin "hide" action) should not be
-- prevented by the other side still pointing at it — it should just stop pointing at anything.

ALTER TABLE releases
  ADD COLUMN IF NOT EXISTS flagged_against_release_id uuid REFERENCES releases(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_releases_flagged_against
  ON releases (flagged_against_release_id)
  WHERE flagged_against_release_id IS NOT NULL;

COMMENT ON COLUMN releases.flagged_against_release_id IS
  'The other release this one was fuzzy-matched against when needs_review was set (tier 3 dedup). Null once resolved (dismissed or merged). Never used to auto-merge — only to show an admin what the suspected duplicate is.';
