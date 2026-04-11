-- Migration 008: Make verification_code nullable
-- The claim flow was updated to use link-back verification (checking for an
-- unstream.stream link on the artist's website) instead of a shared code.
-- The verification_code column is no longer used, but was left as NOT NULL,
-- which broke new artist profile creation.

alter table artist_profiles
  alter column verification_code drop not null;
