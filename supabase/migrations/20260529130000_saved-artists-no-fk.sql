-- Migration 014: Make saved_artists work without requiring an artists table row
-- Fans can save any artist from search results without creating a stub row in `artists`.
-- The /a/:slug route is only for claimed/verified artists — unclaimed artists don't get profile pages.

-- Add columns to store search result data directly
ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS artist_slug TEXT;
ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS artist_name TEXT;
ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS artist_image_url TEXT;

-- Make artist_id nullable — a saved artist may not exist in the artists table
ALTER TABLE saved_artists ALTER COLUMN artist_id DROP NOT NULL;

-- Drop the RESTRICT FK — if an artist row IS deleted, the save should survive
ALTER TABLE saved_artists DROP CONSTRAINT IF EXISTS saved_artists_artist_id_fkey;
ALTER TABLE saved_artists ADD CONSTRAINT saved_artists_artist_id_fkey
  FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE SET NULL;

-- Drop old unique constraint on (user_id, artist_id)
-- Every saved artist has a slug from search results, so (user_id, artist_slug) is the natural key
ALTER TABLE saved_artists DROP CONSTRAINT IF EXISTS saved_artists_user_id_artist_id_key;

-- New unique constraint on (user_id, artist_slug) — prevents duplicate saves
CREATE UNIQUE INDEX IF NOT EXISTS saved_artists_user_slug_unique
  ON saved_artists (user_id, artist_slug);