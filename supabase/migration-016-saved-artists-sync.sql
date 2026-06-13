-- Migration 016: Add last_modified and device_id columns to saved_artists for cross-client sync
-- UNS-93: Schema + sync API for cross-client auth
--   last_modified — server-managed timestamp for conflict resolution (last-write-wins)
--   device_id    — debug aid: which client produced this change
-- The trigger ensures UPDATEs bump last_modified to now(), so the server clock
-- is the source of truth for sync ordering. Client-supplied last_modified is
-- only honoured on INSERT (for local-only merge cases in later phases).

ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS last_modified TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Index for efficient "give me everything since X" pull queries
CREATE INDEX IF NOT EXISTS idx_saved_artists_user_last_modified
  ON saved_artists (user_id, last_modified ASC);

-- Trigger: bump last_modified on every UPDATE so edits to notes/supported
-- propagate through the sync endpoint.
CREATE OR REPLACE FUNCTION fn_saved_artists_bump_last_modified()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_modified = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_saved_artists_bump_last_modified ON saved_artists;
CREATE TRIGGER trg_saved_artists_bump_last_modified
  BEFORE UPDATE ON saved_artists
  FOR EACH ROW
  EXECUTE FUNCTION fn_saved_artists_bump_last_modified();

COMMENT ON COLUMN saved_artists.last_modified IS 'Server-managed timestamp; bumped on every UPDATE for sync ordering (UNS-93)';
COMMENT ON COLUMN saved_artists.device_id IS 'Client-supplied device identifier for debugging which device produced a change (UNS-93)';