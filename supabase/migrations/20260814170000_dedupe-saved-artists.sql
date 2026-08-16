-- Collapse duplicate saved_artists rows that name the same artist twice.
--
-- `(user_id, artist_slug)` is the table's natural key (migration 014, which dropped the
-- original `(user_id, artist_id)` constraint so a fan could save an artist with no `artists`
-- row). The cost of that is real: a save made from a search result stores a *synthetic* slug
-- (`modelactriz`, `seoulmetro`, `rodneyowl`, `qobuz-robertlogan`), so a later write using the
-- canonical slug looks like a different artist and inserts a second live row.
--
-- The Bandcamp collection import did exactly that on 2026-08-14 — it checked for an existing
-- row by slug only — duplicating Model/Actriz, Rodney Owl and Seoul Metro in one run. That
-- code now matches on `artist_id` too (bandcamp-sync-background.ts), so this cleans up the
-- rows already written rather than a recurring condition. One pair predates the import
-- (Bird Streets, two saves 19 seconds apart) and is fixed by the same statement.
--
-- Deliberately no unique constraint on `(user_id, artist_id)`: `artist_id` is nullable, so it
-- would exempt exactly the legacy rows most likely to duplicate, and a hard constraint would
-- turn a duplicate save into a failed one for the fan rather than a no-op.
--
-- The losing rows are **tombstoned, not deleted**. saved_artists is synced to the Apple app by
-- `?since=` incremental pulls (migration 017), which learn about removals only from
-- `deleted = true`; a hard delete would leave the duplicate on every device forever. Both the
-- keeper and the tombstone get a fresh `last_modified` so that pull picks up both changes.

WITH grouped AS (
  SELECT
    sa.id,
    -- The truest values across the pair, not whichever row happens to win: `added_at` is when
    -- this fan first saved the artist, and `supported_at` when they first supported them.
    MIN(sa.added_at) OVER dupe AS first_added_at,
    MIN(sa.supported_at) OVER dupe AS first_supported_at,
    BOOL_OR(sa.supported) OVER dupe AS ever_supported,
    COUNT(*) OVER dupe AS group_size,
    ROW_NUMBER() OVER (
      PARTITION BY sa.user_id, sa.artist_id
      -- Keep the row whose slug matches the artists table: it is the slug every link and every
      -- later write derives, so keeping the synthetic one would just re-open the same gap.
      -- Failing that, keep the earliest save.
      ORDER BY (a.slug IS NOT NULL AND sa.artist_slug = a.slug) DESC, sa.added_at ASC, sa.id ASC
    ) AS rn
  FROM saved_artists sa
  LEFT JOIN artists a ON a.id = sa.artist_id
  WHERE sa.deleted = false
    AND sa.artist_id IS NOT NULL
  WINDOW dupe AS (PARTITION BY sa.user_id, sa.artist_id)
),
dupes AS (
  SELECT * FROM grouped WHERE group_size > 1
),
keepers AS (
  UPDATE saved_artists sa
  SET added_at = d.first_added_at,
      supported = d.ever_supported,
      supported_at = CASE WHEN d.ever_supported THEN d.first_supported_at ELSE NULL END,
      last_modified = now()
  FROM dupes d
  WHERE sa.id = d.id AND d.rn = 1
  RETURNING sa.id
)
UPDATE saved_artists sa
SET deleted = true,
    deleted_at = now(),
    last_modified = now()
FROM dupes d
WHERE sa.id = d.id AND d.rn > 1;
