-- Add featured_embed column to artist_profiles
-- Run this in the Supabase SQL editor
ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS featured_embed text;
