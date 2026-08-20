-- Disk IO round 2, Phase 2: make collection matching indexable and art resolvable at sync time.
--
-- Two columns and two indexes on collection_items:
--
-- * `artist_slug` — artistSlug(artist_name), written by the sync. linkCollectionItemsForArtist
--   runs at the end of EVERY catalogue pass (100+/day) and used to find waiting items with
--   `artist_name ILIKE ?` — a full sequential scan of every user's items, across all users, with
--   no index that could ever serve it. With the slug stored, the same question is an equality
--   probe on the partial index below, returning its usual zero rows in microseconds.
--
--   Backfill is deliberately left to the sync: artistSlug is JS (unicode normalization), and a
--   SQL approximation that disagrees with it would un-match items in exactly the way
--   slug-vs-name normalization bugs always do. Rows synced before this migration have a NULL
--   slug until their owner's next re-sync rewrites them (the diff treats the new column as a
--   change, once); the linker keeps an ILIKE fallback for NULL-slug rows and drops it when
--   `SELECT count(*) FROM collection_items WHERE artist_slug IS NULL` reaches zero.
--
-- * `art_ref` — the Subsonic cover-art id the album list already returns and the sync used to
--   throw away. The art proxy needed one extra authenticated Bandcamp request per image
--   (getAlbum) just to re-derive this; stored, that request disappears. NULL means "not seen by
--   a sync since this column existed" and the proxy falls back to asking Bandcamp.
--
-- * The partial index serves the linker's probe. Partial on release_id IS NULL because linked
--   items are never candidates, which also keeps the index small and cheap to maintain.
--
-- * idx_collection_items_release_id covers the ON DELETE SET NULL foreign key — without it a
--   release delete or merge scans collection_items.
--
-- No RLS changes: collection_items already has its policies (20260809120000), and neither
-- column widens what a row reveals.

ALTER TABLE collection_items ADD COLUMN IF NOT EXISTS artist_slug text;
ALTER TABLE collection_items ADD COLUMN IF NOT EXISTS art_ref text;

CREATE INDEX IF NOT EXISTS idx_collection_items_artist_slug
  ON collection_items (artist_slug)
  WHERE release_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_collection_items_release_id
  ON collection_items (release_id);
