-- Migration: release_catalog_state
--
-- Bookkeeping for demand-driven release cataloging. One row per artist we have tried to
-- catalog, which is what makes three guards possible:
--
--   1. Cooldown  — never re-crawl an artist within RECATALOG_COOLDOWN, so repeat searches
--                  for the same artist cost nothing upstream.
--   2. Rate cap  — count rows attempted in the last hour to bound how hard we hit Bandcamp
--                  during a traffic spike. Cataloging is triggered by search as well as by
--                  saving, and search is unauthenticated and far higher volume.
--   3. Priority  — a save is a deliberate act by one person; a search is not. When the cap
--                  is reached, saves still get through and searches are dropped.
--
-- Deliberately not a job queue. Cataloging is triggered by a user action and invoked
-- immediately as a background function, so there is no scheduler to feed and nothing to
-- drain. Dropping a searched artist when the cap is reached is fine — the next person to
-- search or save them triggers it again. Add a queue only when something actually needs
-- guaranteed eventual execution.

CREATE TABLE IF NOT EXISTS release_catalog_state (
  artist_id uuid PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,

  -- Last time cataloging *succeeded*. Drives the cooldown.
  last_catalogued_at timestamptz,

  -- Last time cataloging was *attempted*, set before the work starts. Doubles as a claim:
  -- stamping it up front means two near-simultaneous triggers for the same artist don't both
  -- run, and it's the column the hourly rate cap counts.
  last_attempted_at timestamptz NOT NULL DEFAULT now(),

  -- Consecutive failures. Lets a permanently broken artist back off instead of being retried
  -- on every search forever.
  consecutive_failures integer NOT NULL DEFAULT 0,

  -- Truncated on write; this is for debugging, not for display.
  last_error text,

  -- What triggered the most recent attempt. 'saved' outranks 'searched' under the cap.
  last_trigger text NOT NULL DEFAULT 'searched'
    CHECK (last_trigger IN ('saved', 'searched')),

  -- How many releases the last successful run found. A run that suddenly finds 0 where it
  -- previously found 20 is a parser or bot-challenge failure, not an artist deleting their
  -- catalog — worth being able to see.
  releases_found integer,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The rate-cap query: how many artists were attempted in the last hour.
CREATE INDEX IF NOT EXISTS idx_release_catalog_state_attempted
  ON release_catalog_state (last_attempted_at DESC);

-- The cooldown query.
CREATE INDEX IF NOT EXISTS idx_release_catalog_state_catalogued
  ON release_catalog_state (last_catalogued_at DESC NULLS FIRST);

DROP TRIGGER IF EXISTS trg_release_catalog_state_updated_at ON release_catalog_state;
CREATE TRIGGER trg_release_catalog_state_updated_at
  BEFORE UPDATE ON release_catalog_state
  FOR EACH ROW
  EXECUTE FUNCTION set_releases_updated_at();

-- Server-only: nothing in the client needs to read crawl bookkeeping. RLS on with no
-- policies means the service-role client (which bypasses RLS) is the only reader or writer,
-- and anon/authenticated get nothing. Deliberate, not an oversight — same pattern as
-- bandcamp_slug_probes.
ALTER TABLE release_catalog_state ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE release_catalog_state IS
  'Per-artist release-cataloging bookkeeping: cooldown, hourly rate cap, and save-over-search priority. Server-only; no RLS policies by design.';
COMMENT ON COLUMN release_catalog_state.last_attempted_at IS
  'Stamped before work begins, so it also acts as a claim against concurrent triggers and as the rate-cap counter.';
