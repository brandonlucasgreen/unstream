-- Migration 004: Artist merge overrides
-- Manual curation table for merging search results that the algorithmic
-- pipeline can't match (e.g., same artist with different catalogs across platforms).

CREATE TABLE artist_merge_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_name text NOT NULL,
  platform_urls text[] NOT NULL,
  excluded_urls text[] NOT NULL DEFAULT '{}',
  canonical_image_url text,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_merge_overrides_urls ON artist_merge_overrides USING GIN (platform_urls);
