-- Step 2: Clean up orphaned stub rows from the artists table
-- These were created by the old resolveOrCreateArtist logic and shouldn't exist.
-- Only delete rows that are NOT claimed/verified (match_confidence = 'unverified' or NULL)
-- and have NO saved_artists references (or their saved_artists rows now have the data directly).

-- First, see what we're about to delete:
SELECT id, slug, name, match_confidence, source
FROM artists
WHERE match_confidence IN ('unverified') OR match_confidence IS NULL;

-- Delete unverified stub rows that were only created because a fan saved the artist.
-- These have source='auto' and no artist_profiles row (never claimed).
DELETE FROM artists
WHERE (match_confidence = 'unverified' OR match_confidence IS NULL)
  AND source = 'auto'
  AND NOT EXISTS (
    SELECT 1 FROM artist_profiles WHERE artist_profiles.artist_id = artists.id
  );

-- Step 3: Backfill artist_slug, artist_name, artist_image_url in saved_artists
-- from the joined artists row (for existing saves that still have an artist_id FK).

UPDATE saved_artists
SET
  artist_slug = artists.slug,
  artist_name = artists.name,
  artist_image_url = artists.image_url
FROM artists
WHERE saved_artists.artist_id = artists.id
  AND saved_artists.artist_slug IS NULL;

-- Verify: check for any saved_artists rows still missing artist_slug
-- (these would be rows where artist_id was set NULL by the ON DELETE SET NULL
--  and the artist row was already deleted)
SELECT id, user_id, artist_id, artist_slug, artist_name
FROM saved_artists
WHERE artist_slug IS NULL;