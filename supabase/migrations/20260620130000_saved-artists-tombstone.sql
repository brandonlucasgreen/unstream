-- Migration 017: Add tombstone columns to saved_artists for cross-device removal sync
-- UNS-112: When a user removes an artist on device B, device A must see the removal
-- during the same foreground session (not just on cold restart). Hard DELETEs were
-- invisible to incremental pulls (?since=), so we soft-delete instead.
--
--   deleted     — true when the artist has been removed (tombstone)
--   deleted_at  — when the tombstone was created (for garbage collection later)
--
-- The sync endpoint includes tombstones in ?since= results so clients can prune
-- their in-memory lists. A periodic force-pull (every 5 min) is the backstop.
--
-- UNS-129 (closed): the composite (user_id, last_modified) index for the hot
-- sync path is already created by migration-016
-- (`idx_saved_artists_user_last_modified` on `saved_artists (user_id, last_modified)`).
-- No change needed here.

ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Index for tombstone queries: e.g. "show me all tombstones for this user
-- older than 30 days" (the GC query, UNS-128).
CREATE INDEX IF NOT EXISTS idx_saved_artists_user_deleted
  ON saved_artists (user_id, deleted);

COMMENT ON COLUMN saved_artists.deleted IS 'Tombstone flag: true means the artist was removed but the row is kept for sync propagation (UNS-112)';
COMMENT ON COLUMN saved_artists.deleted_at IS 'When the tombstone was created; can be purged after all devices have synced past it';
