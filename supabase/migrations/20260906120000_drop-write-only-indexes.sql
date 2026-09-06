-- Drop five indexes that cost a write on every insert or update and serve no query.
--
-- Disk I/O round 4 (docs/specs/supabase-disk-io-investigation.md). Postgres maintains every index
-- on a table on every insert, and on every update unless no indexed column changed (a "HOT"
-- update). An index nothing reads is therefore pure write cost, and on `artists` it is worse
-- than that: it is what stops every update on the table from being HOT.
--
-- Each drop, and why it is safe:
--
-- * idx_artists_updated (updated_at). The `artists_updated_at` trigger bumps this column on
--   every update, so its presence forces every `artists` update to re-enter the row in all six
--   of the table's indexes, including the trigram GIN on `name`. No query filters or orders on
--   `updated_at`: getArtistBySlug compares it in JavaScript after fetching by slug, and the
--   sitemap generator selects it for every row with no filter. With this gone, an update that
--   changes only unindexed columns (image_url, updated_at, city, last_enriched_at) is HOT.
--
-- * idx_artists_slug (slug). `slug text unique not null` already creates a unique index on the
--   same column; this was a second, identical one from the baseline migration.
--
-- * idx_app_events_created (created_at DESC). An exact duplicate of idx_app_events_created_at,
--   created on 2026-08-11 by a migration whose comment believed the table had only one index.
--   The original stays.
--
-- * idx_app_events_type_app (event_type, app, created_at DESC). Every dashboard query filters on
--   event_type and created_at; none pairs event_type with app (analytics_events_by_app groups by
--   app after filtering). idx_app_events_type_created (event_type, created_at DESC), from the
--   same 2026-08-11 migration, serves all of them and is narrower.
--
-- * idx_releases_artist_id (artist_id). A strict prefix of idx_releases_artist_chrono
--   (artist_id, release_date, created_at); the planner uses the composite for any lookup the
--   single-column index could serve, including the foreign-key check. `releases` is the hottest
--   insert table in the schema and this brought its index count from nine to eight.
--
-- Not CONCURRENTLY: the CLI applies each migration inside a transaction, where CONCURRENTLY is
-- not allowed. Every one of these tables is a few thousand rows, so the exclusive lock a plain
-- DROP INDEX takes lasts milliseconds.
--
-- Confirm before or after with query 5 in the investigation doc (pg_stat_user_indexes): each of
-- these should show idx_scan at or near zero.

DROP INDEX IF EXISTS idx_artists_updated;
DROP INDEX IF EXISTS idx_artists_slug;
DROP INDEX IF EXISTS idx_app_events_created;
DROP INDEX IF EXISTS idx_app_events_type_app;
DROP INDEX IF EXISTS idx_releases_artist_id;
