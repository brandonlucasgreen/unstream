-- Migration 013: Saved Artists
-- Users can save artists they like for later discovery.
-- This enables a unified "save for later" feature across both claimed and discovered artists.

CREATE TABLE saved_artists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE RESTRICT,
  notes TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, artist_id)
);

-- Index for efficient user lookups
CREATE INDEX idx_saved_artists_user_id ON saved_artists(user_id);

-- Composite index for save/remove/check queries
CREATE INDEX idx_saved_artists_user_artist ON saved_artists(user_id, artist_id);

-- Row-Level Security
ALTER TABLE saved_artists ENABLE ROW LEVEL SECURITY;

-- Users can view their own saved artists
CREATE POLICY "Users can view own saved artists"
  ON saved_artists FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own saved artists
CREATE POLICY "Users can insert own saved artists"
  ON saved_artists FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own saved artists (notes)
CREATE POLICY "Users can update own saved artists"
  ON saved_artists FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can delete their own saved artists
CREATE POLICY "Users can delete own saved artists"
  ON saved_artists FOR DELETE
  USING (auth.uid() = user_id);
