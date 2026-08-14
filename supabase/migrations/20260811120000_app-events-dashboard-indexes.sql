-- Migration: index app_events for the admin dashboard's queries
--
-- `/admin/analytics` fires nine queries at app_events on every load (see
-- api/functions/analytics-dashboard.ts): five counts and breakdowns filtered by
-- `event_type` + `created_at`, and one "20 most recent events" ordered by `created_at DESC`.
--
-- None of them had a usable index. The table's only index was
-- `idx_app_events_unscrubbed (created_at) WHERE session_hash IS NOT NULL`, added for the
-- session-hash retention sweep, and it can't serve these:
--
--   * it doesn't carry `event_type`, so the eight filtered queries can't use it as a leading
--     column; and
--   * its `WHERE session_hash IS NOT NULL` predicate excludes exactly the rows the dashboard
--     cares most about — everything older than 90 days, which is scrubbed — so the further back
--     a query reaches, the less of the table the index covers.
--
-- So each dashboard load meant nine sequential scans of a table that only ever grows, three of
-- them `count: 'exact'`, which Postgres can only answer by scanning. That is a contributor to
-- the Disk IO Budget alert, and unlike the write-churn causes it gets steadily worse on its own.
--
-- The fix is indexes, deliberately not retention. The 2026-08-08 migration weighed deleting old
-- rows and rejected it — "it costs year-over-year trends for no gain" — and that reasoning still
-- holds. Indexing is what makes keeping the history cheap enough to be free.
--
-- Measured on postgres:16 with 60,000 rows over two years, before -> after:
--
--   count by event_type over 30 days   779 -> 395 buffers,  3.7ms -> 1.0ms
--   20 most recent events              782 ->  22 buffers,  7.6ms -> 0.1ms  (sort eliminated)
--
-- The second is the one that matters most, and both gaps widen on their own: a sequential scan
-- grows with the whole table forever, while the index scans grow only with the window queried.

-- Serves the eight event_type-filtered queries: `event_type` equality first, then the
-- `created_at >= …` range, then `created_at DESC` ordering for free.
CREATE INDEX IF NOT EXISTS idx_app_events_type_created
  ON app_events (event_type, created_at DESC);

-- Serves the unfiltered "20 most recent events" query, which the index above cannot: it has no
-- event_type predicate, so it would otherwise scan and sort the whole table to return 20 rows.
--
-- Unlike idx_app_events_unscrubbed this carries no WHERE clause, so it stays complete as rows are
-- scrubbed. That index remains useful for the retention sweep itself, which specifically wants
-- only unscrubbed rows and benefits from a smaller index.
CREATE INDEX IF NOT EXISTS idx_app_events_created
  ON app_events (created_at DESC);
