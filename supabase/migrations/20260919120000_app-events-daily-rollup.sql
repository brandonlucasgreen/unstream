-- Migration: bound app_events with a daily rollup and 90-day retention
--
-- app_events is the only table in the database with no row retention: one row per search,
-- platform click, page view and download since 2026-04-12, each insert maintaining four
-- indexes (after round 4 dropped the duplicate pair), and — until this migration — every row
-- rewritten a *second* time at 90 days by the session-hash scrub, never as a cheap in-place
-- update because `session_hash` is the partial index's predicate, so the update changes index
-- membership. That unbounded working set is a named suspect in every disk I/O round
-- (docs/specs/supabase-disk-io-investigation.md, rounds 3–6), and on a Nano instance it costs
-- reads too: once the table outgrows the tiny buffer cache, the dashboard's indexed scans
-- become disk reads — the failure mode behind the 2026-09-19 wedge.
--
-- What this does:
--
--   * `app_events_daily`: daily counts by event_type, app, and one context key/value.
--   * `rollup_app_events()`, a nightly pg_cron job in the 03:20 UTC slot the scrub used to
--     occupy, which aggregates rows older than 90 days into the rollup and deletes them in
--     one atomic statement. It replaces `expire_app_event_session_hashes`, which becomes
--     redundant: nothing it scrubbed survives to 90 days any more.
--   * The five `analytics_*` functions read `rollup UNION raw`, so every dashboard number
--     survives. Every number the dashboard shows is a count by type/app/day/context field,
--     and row-level history older than 90 days was already anonymous — the scrub nulled the
--     only per-visitor field. The three direct counts in analytics-dashboard.ts (searches
--     today / 7d / 30d) read windows well inside 90 days, so raw rows always answer them and
--     they need no change.
--
-- What the product loses: nothing the dashboard can display. What it gains: `app_events`
-- stops growing, the second write per row disappears (a delete is one heap write, and its
-- dead tuples no longer sit under live indexes churning autovacuum), and the 90-day
-- session-hash promise becomes deletion — strictly stronger privacy. The privacy policy's
-- "the session token is erased after 90 days … the counts themselves are kept as historical
-- trends" describes this table almost word for word; no copy change needed.
--
-- The first nightly run deletes the whole backlog older than 90 days in one statement, at
-- 03:20 UTC in low traffic. Same shape as the scrub's own first-run backlog clear, and one
-- large delete beats one large update: the rows it touches were already scrubbed, so it is
-- one heap write each instead of six more index writes each.

CREATE TABLE IF NOT EXISTS app_events_daily (
  day date NOT NULL,
  event_type text NOT NULL,
  app text NOT NULL,
  -- NULL marks the row that counts the events themselves; a non-NULL key carries the day's
  -- count for one context field (e.g. platform='bandcamp'). A raw event with two context
  -- keys (a search carries has_results and result_count) therefore contributes one count row
  -- plus two key rows — the count rows feed the by-day and by-app functions, the key rows
  -- feed the by-platform and by-service ones. One row per event per key can't double-count
  -- anything, because no function sums across both kinds.
  context_key text,
  context_value text,
  count bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_events_daily_lookup
  ON app_events_daily (event_type, day);

-- Server-only table, deliberately: RLS enabled with no policies, like app_events' read side
-- and the probe cache. The service-role client (the nightly job and the analytics_* functions,
-- both service-role) bypasses RLS; anon gets nothing. The missing policies are not an
-- oversight.
ALTER TABLE app_events_daily ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE app_events_daily IS
  'Daily rollup of app_events rows older than 90 days, built and deleted by the nightly rollup_app_events() job. Server-only: RLS enabled, no policies.';

-- Aggregate into the rollup and delete, as one statement. The DELETE's RETURNING feeds the
-- INSERT, so the two halves commit or roll back together: a crash between "rolled up" and
-- "deleted" — in either order — is unreachable, and the job can never lose rows or count
-- them twice.
CREATE OR REPLACE FUNCTION rollup_app_events()
RETURNS void AS $$
BEGIN
  WITH aged AS (
    DELETE FROM app_events
    WHERE created_at < now() - interval '90 days'
    RETURNING created_at, event_type, app, context
  ),
  flattened AS (
    -- jsonb_each_text spells booleans and numbers as text, which is exactly the text the
    -- analytics_* functions compare context->>'...' against, so raw and rolled-up values
    -- group identically. Keys with a JSON null value yield a NULL context_value; the
    -- function definitions below exclude those rows to match the raw-side IS NOT NULL
    -- filters (the API's sanitizer never stores them, but the two sides should not be
    -- able to disagree).
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, event_type, app,
           NULL::text AS context_key, NULL::text AS context_value
    FROM aged
    UNION ALL
    SELECT (a.created_at AT TIME ZONE 'UTC')::date, a.event_type, a.app,
           kv.key, kv.value
    FROM aged a
    CROSS JOIN LATERAL jsonb_each_text(a.context) AS kv(key, value)
  )
  INSERT INTO app_events_daily (day, event_type, app, context_key, context_value, count)
  SELECT day, event_type, app, context_key, context_value, count(*)
  FROM flattened
  GROUP BY 1, 2, 3, 4, 5;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION rollup_app_events() IS
  'Nightly: aggregate app_events rows older than 90 days into app_events_daily and delete them, atomically. Replaces expire_app_event_session_hashes.';

-- Retire the scrub: nothing it scrubbed survives to its own 90-day deadline any more, so the
-- job is a no-op with a full-index-maintaining partial index left behind. Drop both.
SELECT cron.unschedule('expire-app_event_session_hashes')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'expire-app_event_session_hashes'
  );
DROP FUNCTION IF EXISTS expire_app_event_session_hashes();
DROP INDEX IF EXISTS idx_app_events_unscrubbed;

-- Schedule the rollup in the scrub's old slot: 3:20am UTC daily, offset from the 3am
-- saved-artists tombstone GC so the two single-statement jobs don't land together.
-- Idempotent: unschedule first so re-running the migration doesn't error.
SELECT cron.unschedule('rollup-app-events')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'rollup-app-events'
  );
SELECT cron.schedule(
  'rollup-app-events',
  '20 3 * * *',
  $$SELECT rollup_app_events();$$
);

COMMENT ON COLUMN app_events.session_hash IS
  'Keyed HMAC of (ip + user_agent + date) for same-day deduplication. Never a raw IP. The whole row — hash included — is deleted at 90 days by rollup_app_events(); until 2026-09-19 the hash alone was nulled at 90 days by expire_app_event_session_hashes().';

-- ---------------------------------------------------------------------------
-- The five analytics_* functions now read rollup UNION raw.
--
-- The rollup only ever holds days older than 90 days and raw only ever holds the last 90,
-- so for the dashboard's 7- and 30-day windows the raw side answers alone and the UNION is
-- future-proofing: it keeps full history answerable (the year-over-year argument from
-- 2026-08-08) if a caller ever passes an older cutoff. One documented boundary: a cutoff
-- that lands mid-way through a *rolled-up* day counts that whole day. No caller does —
-- both live callers pass 7d/30d — and daily counts are the granularity the rollup exists
-- to keep, so whole-day precision on pre-90-day cutoffs is the honest behavior.
--
-- SECURITY INVOKER (the default) stays deliberate, as in the original definitions: with no
-- policies on either table, these functions cannot become a read hole, and PostgREST
-- exposes every public-schema function at /rest/v1/rpc/<name>.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION analytics_daily_events(p_since TIMESTAMPTZ)
RETURNS TABLE (day DATE, event_type TEXT, events BIGINT) AS $$
  SELECT d.day, d.event_type, sum(d.c)::bigint
  FROM (
    SELECT r.day AS day, r.event_type AS event_type, r.count AS c
    FROM app_events_daily r
    WHERE r.context_key IS NULL
      AND r.event_type IN ('search', 'platform_click', 'extension_activated')
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT (e.created_at AT TIME ZONE 'UTC')::date, e.event_type, count(*)
    FROM app_events e
    WHERE e.event_type IN ('search', 'platform_click', 'extension_activated')
      AND e.created_at >= p_since
    GROUP BY 1, 2
  ) d
  GROUP BY d.day, d.event_type;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION analytics_events_by_app(p_since TIMESTAMPTZ)
RETURNS TABLE (app TEXT, event_type TEXT, events BIGINT) AS $$
  SELECT a.app, a.event_type, sum(a.c)::bigint
  FROM (
    SELECT r.app AS app, r.event_type AS event_type, r.count AS c
    FROM app_events_daily r
    WHERE r.context_key IS NULL
      AND r.event_type IN ('search', 'platform_click')
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT e.app, e.event_type, count(*)
    FROM app_events e
    WHERE e.event_type IN ('search', 'platform_click')
      AND e.created_at >= p_since
    GROUP BY 1, 2
  ) a
  GROUP BY a.app, a.event_type;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION analytics_platform_clicks(p_since TIMESTAMPTZ)
RETURNS TABLE (platform TEXT, clicks BIGINT) AS $$
  SELECT p.platform, sum(p.c)::bigint
  FROM (
    SELECT r.context_value AS platform, r.count AS c
    FROM app_events_daily r
    WHERE r.event_type = 'platform_click'
      AND r.context_key = 'platform'
      AND r.context_value IS NOT NULL
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT e.context->>'platform', count(*)
    FROM app_events e
    WHERE e.event_type = 'platform_click'
      AND e.created_at >= p_since
      AND e.context->>'platform' IS NOT NULL
    GROUP BY 1
  ) p
  GROUP BY p.platform
  ORDER BY 2 DESC;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION analytics_streaming_services(p_since TIMESTAMPTZ)
RETURNS TABLE (service TEXT, activations BIGINT) AS $$
  SELECT s.service, sum(s.c)::bigint
  FROM (
    SELECT r.context_value AS service, r.count AS c
    FROM app_events_daily r
    WHERE r.event_type = 'extension_activated'
      AND r.context_key = 'streaming_service'
      AND r.context_value IS NOT NULL
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT e.context->>'streaming_service', count(*)
    FROM app_events e
    WHERE e.event_type = 'extension_activated'
      AND e.created_at >= p_since
      AND e.context->>'streaming_service' IS NOT NULL
    GROUP BY 1
  ) s
  GROUP BY s.service
  ORDER BY 2 DESC;
$$ LANGUAGE sql STABLE;

-- Success rate. `completed` counts events carrying a has_results key, `with_results` those
-- where it is true — the same separation the original definition drew, including against the
-- context-free initiation events written before 2026-08-19, which exist only in the raw side
-- of the UNION and stay outside both sides of the ratio. On the rollup side those old rows
-- hold no has_results key rows, so they contribute nothing here either.
CREATE OR REPLACE FUNCTION analytics_search_success(p_since TIMESTAMPTZ)
RETURNS TABLE (completed BIGINT, with_results BIGINT) AS $$
  SELECT
    (SELECT coalesce(sum(r.count), 0)
     FROM app_events_daily r
     WHERE r.event_type = 'search'
       AND r.context_key = 'has_results'
       AND r.day >= (p_since AT TIME ZONE 'UTC')::date)
      + count(*) FILTER (WHERE jsonb_exists(e.context, 'has_results')) AS completed,
    (SELECT coalesce(sum(r.count), 0)
     FROM app_events_daily r
     WHERE r.event_type = 'search'
       AND r.context_key = 'has_results'
       AND r.context_value = 'true'
       AND r.day >= (p_since AT TIME ZONE 'UTC')::date)
      + count(*) FILTER (WHERE e.context->'has_results' = 'true'::jsonb) AS with_results
  FROM app_events e
  WHERE e.event_type = 'search'
    AND e.created_at >= p_since;
$$ LANGUAGE sql STABLE;

-- EXECUTE is granted to PUBLIC by default on a new function, so revoking is not optional:
-- PostgREST would otherwise expose all five at /rest/v1/rpc/<name>.
REVOKE EXECUTE ON FUNCTION analytics_daily_events(TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION analytics_events_by_app(TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION analytics_platform_clicks(TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION analytics_streaming_services(TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION analytics_search_success(TIMESTAMPTZ) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION analytics_daily_events(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION analytics_events_by_app(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION analytics_platform_clicks(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION analytics_streaming_services(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION analytics_search_success(TIMESTAMPTZ) TO service_role;

-- rollup_app_events() deletes rows, so it must not sit where PostgREST will expose it to
-- anyone with the anon key. The two older cron job functions (gc_saved_artists_tombstones,
-- expire_app_event_session_hashes) never did this — harmless for them, since the worst an
-- anon call could do is scrub hashes a night early, but this one is a DELETE.
REVOKE EXECUTE ON FUNCTION rollup_app_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rollup_app_events() TO service_role;