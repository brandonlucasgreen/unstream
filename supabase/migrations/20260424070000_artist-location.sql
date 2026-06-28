-- Migration 011: Artist location columns
-- Stores location data captured from MusicBrainz/Bandcamp/Mirlo enrichment.
-- Free-text city + country (no geocoding). country_code is ISO alpha-2 from
-- MusicBrainz when available, used as a country fallback for display.
-- Written by persistEnrichment for unclaimed artists; claimed artists manage
-- their own location via the claim/edit flow (Phase 3) and are skipped by
-- the enrichment path (match_confidence='claimed' short-circuit in db.ts).

alter table artists add column if not exists city text;
alter table artists add column if not exists country text;
alter table artists add column if not exists country_code text;
