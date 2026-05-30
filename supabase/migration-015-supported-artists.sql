-- Migration 015: Add supported / supported_at columns to saved_artists
-- UNS-67: Allow logged-in users to mark saved artists as "supported".
--   supported     — whether the user has flagged this artist as supported
--   supported_at   — when the user marked it (null if not supported or unsupported)
-- Removing a saved artist cascades the row away; re-saving defaults supported back to false.

ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS supported boolean NOT NULL DEFAULT false;
ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS supported_at timestamptz;

COMMENT ON COLUMN saved_artists.supported IS 'Whether the user has marked this saved artist as supported (UNS-67)';
COMMENT ON COLUMN saved_artists.supported_at IS 'Timestamp when the user marked this artist as supported; null if not supported';