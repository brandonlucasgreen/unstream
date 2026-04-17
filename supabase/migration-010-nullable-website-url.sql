-- Migration 010: Make website_url nullable on artist_profiles
-- Admin-approved manual verification requests may not include a website URL;
-- the artist can add one later via the artist-edit flow. Parallels migration 008
-- which did the same for verification_code after the old code-based flow was retired.

alter table artist_profiles
  alter column website_url drop not null;
