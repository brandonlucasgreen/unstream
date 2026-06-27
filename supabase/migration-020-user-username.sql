-- Migration 020: Add username column to auth.users for public sharing (UNS-31 PR 1)
-- Users can set a username that becomes their public handle for sharing saved artists.
-- Format: 3-20 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen.
-- Uniqueness enforced by UNIQUE constraint; format enforced by CHECK constraint.

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

ALTER TABLE auth.users ADD CONSTRAINT username_format
  CHECK (username IS NULL OR username ~ '^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$');

COMMENT ON COLUMN auth.users.username IS 'User-chosen public handle for sharing saved artists (UNS-31). NULL until the user sets one via /settings.';