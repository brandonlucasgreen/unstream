-- Migration: platform link suppressions
--
-- Lets an admin remove a single wrong platform link from a search result without
-- removing the artist. The motivating case: a *.bandcamp.com page that looks
-- legitimate but isn't the major artist it appears under. Merge overrides can't
-- express this — they merge and re-create whole results — and the link may be
-- auto-generated (probe, MusicBrainz relation) rather than stored anywhere
-- editable.
--
-- Scope: artist_name_norm holds the normalized artist name the link was removed
-- from, so a homonym who genuinely owns that page keeps it. NULL means "remove
-- this URL everywhere", for links that are wrong under any name.

CREATE TABLE IF NOT EXISTS platform_link_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Normalized by the API: lowercased, trailing slashes stripped.
  url text NOT NULL,
  -- Platform the link belonged to, for display in the admin list only.
  source_id text,
  -- Display name as shown in the result, kept so the admin list is readable.
  artist_name text,
  -- Normalized artist name this suppression is scoped to; NULL = all artists.
  artist_name_norm text,
  reason text,
  created_by text,
  created_at timestamptz DEFAULT now()
);

-- One row per (URL, artist), plus at most one global row per URL. Two partial
-- indexes rather than one COALESCE expression index, because Postgres treats
-- NULLs as distinct in a plain unique index — a single index on
-- (url, artist_name_norm) would happily accept duplicate global rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_suppressions_url_artist
  ON platform_link_suppressions (url, artist_name_norm)
  WHERE artist_name_norm IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_link_suppressions_url_global
  ON platform_link_suppressions (url)
  WHERE artist_name_norm IS NULL;

-- Server-only table. Reads and writes go through the service-role client in
-- api/functions/db.ts, which bypasses RLS. Having no policies is deliberate:
-- the anon key must not be able to read or change moderation state.
ALTER TABLE platform_link_suppressions ENABLE ROW LEVEL SECURITY;
