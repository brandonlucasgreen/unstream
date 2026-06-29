-- Migration 024: Add location column to public.usernames (UNS-144)
-- Stores a free-text location string for display on public profiles.
-- Nullable: users who never set a location have NULL (no empty placeholder on profile).

ALTER TABLE public.usernames
  ADD COLUMN IF NOT EXISTS location TEXT;

COMMENT ON COLUMN public.usernames.location IS 'Free-text location string for public profile display (UNS-144).';