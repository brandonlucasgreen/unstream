-- Migration: releases, release_sources, release_offers
--
-- First-class release entities under an artist, for Unstream Releases. Three tables,
-- because a release is one thing that exists in several places, each of which may sell it
-- in several formats at different prices:
--
--   releases         one row per actual release (album, EP, single…)
--   release_sources  where that release can be found — one row per platform
--   release_offers   what you can buy there — one row per format, with price
--
-- Schema only. No application code reads or writes these yet.
--
-- Deliberately NOT here: the `artist_links.latest_release` jsonb lift proposed in the
-- original spec. That column holds one release per platform per artist, so lifting it
-- would produce a "discography" of length 1. Catalog ingest supersedes it. The jsonb
-- column stays as-is — it remains load-bearing for search disambiguation
-- (allReleaseTitles, release-overlap merging), which is a separate consumer with a
-- separate shape.

-- ---------------------------------------------------------------------------
-- releases
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,

  -- Display-quality title, as the source presents it (accents and punctuation intact).
  title text NOT NULL,

  -- URL segment for /a/{artist}/{slug}. Unique per artist.
  slug text NOT NULL,

  -- Normalized title used for dedup only — never displayed. Built with
  -- normalizeForComparison() from search-utils.ts, which NFD-folds accents rather than
  -- deleting them, so non-Latin titles survive instead of collapsing to an empty string.
  match_key text NOT NULL,

  -- Source-native type. Kept granular on purpose: matching *within* a type is the single
  -- most useful dedup signal we have, and collapsing everything to album-or-single throws
  -- it away. 'other' is the escape hatch for source values we don't recognize.
  release_type text NOT NULL DEFAULT 'other'
    CHECK (release_type IN ('album', 'ep', 'single', 'compilation', 'live', 'remix', 'other')),

  -- Sanity-bounded on the way in. The lower bound is a CHECK; the upper bound
  -- (roughly today + 3 years) can't be, because now() isn't immutable and CHECK
  -- constraints must be. Enforced in release-utils instead. This matters: Mirlo has a
  -- live release dated 2925-11-02, which unbounded would sort to the top of every
  -- chronology and land in every subscriber's calendar.
  release_date date CHECK (release_date IS NULL OR release_date >= DATE '1900-01-01'),

  -- How much of release_date is real. MusicBrainz returns year-only and month-only dates,
  -- and rendering "January 1" for a year-only date invents a fact — it also poisons any
  -- date-proximity dedup that assumes day precision.
  date_precision text NOT NULL DEFAULT 'day'
    CHECK (date_precision IN ('day', 'month', 'year', 'unknown')),

  -- 'announced' = dated in the future or flagged as a pre-order upstream. Derived on
  -- ingest, stored so feeds and chronologies can filter without recomputing per request.
  -- A list that silently mixes future and past releases under "newest first" reads as broken.
  status text NOT NULL DEFAULT 'released'
    CHECK (status IN ('announced', 'released')),

  artwork_url text,

  -- Cross-source identity anchors. Both are pre-existing groupings we get for free:
  -- MusicBrainz release groups, and Discogs masters (which already collapse every
  -- pressing of a record into one entity). Where either is present, dedup is exact
  -- rather than a title guess.
  musicbrainz_release_group_id text,
  discogs_master_id text,

  -- Suppression and review, shipped with the schema rather than added later. Auto-created
  -- releases inherit the Bandcamp probe's residual wrong-artist rate, and a wrong release
  -- here becomes a durable URL asserting that an artist made a record they didn't.
  -- Ingest must never write is_hidden.
  is_hidden boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,

  -- Provenance. 'claimed' means a verified artist authored or corrected this row.
  -- Mirrors artist_links.source so there's one convention in the codebase.
  source text NOT NULL DEFAULT 'auto'
    CHECK (source IN ('auto', 'claimed')),

  -- Field-level provenance: names of columns a verified artist has edited, which a
  -- re-crawl must leave alone. Scheduled ingest re-runs forever, so without this every
  -- crawl quietly reverts an artist's corrections — data loss that is slow, repeated, and
  -- by design, which makes it far harder to notice than a one-off bad write.
  -- e.g. '{title,release_date}'
  curated_fields text[] NOT NULL DEFAULT '{}',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (artist_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_releases_artist_id ON releases (artist_id);

-- The primary read for both the artist-page section and the feeds: one artist's releases,
-- newest first. release_date is nullable and V1 data often lacks it, so created_at is a
-- stable tiebreaker — otherwise "newest first" is nondeterministic between requests.
CREATE INDEX IF NOT EXISTS idx_releases_artist_chrono
  ON releases (artist_id, release_date DESC NULLS LAST, created_at DESC);

-- Dedup lookups happen within (artist, type) — see the release_type comment.
CREATE INDEX IF NOT EXISTS idx_releases_match
  ON releases (artist_id, release_type, match_key);

-- Identity anchors are unique per artist where present. Partial indexes because Postgres
-- treats NULLs as distinct, so a plain unique index would allow unlimited NULL rows but
-- also wouldn't express "at most one row per MBID per artist" the way this does.
CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_mbid
  ON releases (artist_id, musicbrainz_release_group_id)
  WHERE musicbrainz_release_group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_discogs_master
  ON releases (artist_id, discogs_master_id)
  WHERE discogs_master_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- release_sources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS release_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,

  -- Platform id from api/shared/platform-registry.ts. No is_streaming boolean: the
  -- registry already carries category (marketplace / patronage / decentralized / library
  -- / official / social) plus payout, which is strictly more information and one place to
  -- maintain.
  platform text NOT NULL,

  url text NOT NULL,

  -- The platform's own stable id for this release — Bandcamp's data-item-id
  -- ("album-1891263657", which also encodes album-vs-track), Mirlo's trackGroup id,
  -- a Discogs release id. This is what makes re-ingest idempotent: a title can change
  -- upstream, an id doesn't, so we update in place instead of minting a duplicate.
  external_id text,

  source text NOT NULL DEFAULT 'auto'
    CHECK (source IN ('auto', 'claimed')),

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (release_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_release_sources_release_id ON release_sources (release_id);

-- Global, not per-release: the same (platform, external_id) must never appear under two
-- releases, or one upstream record has been split in two. This is the constraint that
-- makes re-crawls safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_sources_external
  ON release_sources (platform, external_id)
  WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- release_offers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS release_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_source_id uuid NOT NULL REFERENCES release_sources(id) ON DELETE CASCADE,

  format text NOT NULL DEFAULT 'other'
    CHECK (format IN ('digital', 'vinyl', 'cassette', 'cd', 'book', 'merch', 'other')),

  -- Nullable: plenty of releases are name-your-price, free, or listed without a figure.
  price numeric(10, 2) CHECK (price IS NULL OR price >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),

  availability text NOT NULL DEFAULT 'unknown'
    CHECK (availability IN ('available', 'preorder', 'sold_out', 'unknown')),

  -- Prices change and vinyl sells out. Offers are a claim with an age, not a fact —
  -- surface this so a page can say how fresh it is instead of promising stale stock.
  captured_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (release_source_id, format)
);

CREATE INDEX IF NOT EXISTS idx_release_offers_source_id ON release_offers (release_source_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger (releases only — the others carry last_seen_at / captured_at)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_releases_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_releases_updated_at ON releases;
CREATE TRIGGER trg_releases_updated_at
  BEFORE UPDATE ON releases
  FOR EACH ROW
  EXECUTE FUNCTION set_releases_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — public read, service write (same shape as artists / artist_links)
-- ---------------------------------------------------------------------------

ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read access" ON releases;
DROP POLICY IF EXISTS "Public read access" ON release_sources;
DROP POLICY IF EXISTS "Public read access" ON release_offers;

CREATE POLICY "Public read access" ON releases FOR SELECT USING (true);
CREATE POLICY "Public read access" ON release_sources FOR SELECT USING (true);
CREATE POLICY "Public read access" ON release_offers FOR SELECT USING (true);

-- Writes are service-role only. The service key bypasses RLS, so the absence of
-- insert/update/delete policies is what keeps anon and authenticated clients read-only —
-- deliberate, not an oversight. Artist curation will go through an authenticated function
-- that checks profile ownership server-side, not through a client-side RLS policy.

COMMENT ON TABLE releases IS
  'One row per release under an artist. Display entity for Unstream Releases; artist_links.latest_release remains the separate search-disambiguation shape.';
COMMENT ON TABLE release_sources IS
  'Where a release can be found — one row per platform. external_id is the platform''s stable id, which makes re-ingest idempotent.';
COMMENT ON TABLE release_offers IS
  'What you can buy at a source: format, price, availability. captured_at because prices and stock go stale.';
COMMENT ON COLUMN releases.curated_fields IS
  'Column names a verified artist has edited. Scheduled ingest must not overwrite these.';
COMMENT ON COLUMN releases.match_key IS
  'Normalized title for dedup only, via normalizeForComparison(). Never displayed.';
