-- Add featured_embed column to artist_profiles
-- Run this in the Supabase SQL editor
ALTER TABLE artist_profiles ADD COLUMN IF NOT EXISTS featured_embed text;

-- Add display_name column to artist_links for custom "other" links
ALTER TABLE artist_links ADD COLUMN IF NOT EXISTS display_name text;
