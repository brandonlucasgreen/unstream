-- Migration: a release may hold more than one source row per platform
--
-- `UNIQUE (release_id, platform)` encoded an assumption that holds for every platform except
-- the one where it matters: that a release is findable at most once on any given platform.
-- Discogs carries two masters for one record often enough that 59 same-artist, same-title
-- duplicate pairs in the catalog have a Discogs source on both sides ("Blonde" twice in 2014,
-- "Petal" twice on 2026-07-31) — and `mergeReleases` refused every one of them, because moving
-- the second source onto the survivor would have violated this constraint. The refusal was
-- correct given the constraint; the constraint was the thing that was wrong.
--
-- Identity moves down to the platform's own id, which is what actually tells two rows on one
-- platform apart. COALESCE rather than NULLS NOT DISTINCT so this doesn't depend on the
-- Postgres version: a release may hold several sources per platform, but at most one of them
-- may be missing an external id, because two id-less rows on one platform are
-- indistinguishable and nothing downstream could ever reconcile them.
--
-- The global `idx_release_sources_external` — UNIQUE (platform, external_id) — is untouched and
-- still does the load-bearing job: one upstream record can never appear under two releases,
-- which is what keeps re-crawls idempotent.

-- Dropped by discovered name rather than the conventional one. If the constraint were left in
-- place under a name we guessed wrong, the weaker index below would still be created and every
-- merge would keep failing — with nothing in the log to say why.
DO $$
DECLARE target text;
BEGIN
  SELECT c.conname INTO target
  FROM pg_constraint c
  WHERE c.conrelid = 'public.release_sources'::regclass
    AND c.contype = 'u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname)
      FROM pg_attribute a
      WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    ) = ARRAY['platform', 'release_id'];

  IF target IS NOT NULL THEN
    EXECUTE format('ALTER TABLE release_sources DROP CONSTRAINT %I', target);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_sources_release_platform_external
  ON release_sources (release_id, platform, COALESCE(external_id, ''));

COMMENT ON INDEX idx_release_sources_release_platform_external IS
  'Replaces UNIQUE (release_id, platform). A release may be sold on one platform under more than one upstream id (two Discogs masters for one record); it may not carry two rows for the same id, nor two rows with no id at all.';
