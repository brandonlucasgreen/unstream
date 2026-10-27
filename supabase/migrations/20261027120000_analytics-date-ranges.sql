-- Migration: date ranges for /admin/analytics, and search kind / browser breakdowns
--
-- The dashboard showed fixed 7- and 30-day windows. It now takes any range, so every function
-- gains an end date, and the dashboard's breakdowns gain two more context keys:
--
--   * `search_kind` ('typed' | 'now_playing'), sent by all three clients from 2026-10-27 (web)
--     and their next releases (Mac app, extension). The Mac app always made both kinds of
--     search but sent them as identical events; the extension counted every track change as a
--     search and never counted the popup's search box.
--   * `browser` ('chrome' | 'firefox') on every extension event, so the two builds read as
--     separate clients.
--
-- Range semantics: callers pass UTC midnights, `p_since` inclusive and `p_until` exclusive, so
-- a range is a whole number of UTC days. That is what lets the rollup side (whole days, older
-- than 90) and the raw side (timestamps, the last 90) answer the same question exactly; a
-- mid-day bound would count a whole rolled-up day on one side and part of a day on the other.
--
-- analytics_platform_clicks and analytics_streaming_services are replaced by one
-- analytics_context_counts, which counts any one context key and also answers the two new
-- breakdowns. The rollup keeps one count row per context key (20260919120000), so a key can
-- be counted on its own over any range, but two keys can't be crossed: "Firefox now-playing
-- searches" isn't answerable beyond 90 days, and the dashboard doesn't ask it.
--
-- The old one-argument functions are dropped rather than kept as overloads. Between this
-- migration applying and the Netlify deploy finishing, the old dashboard code calls functions
-- that no longer exist and /admin/analytics returns its error state for a few minutes; it is
-- admin-only, and leaving dead overloads behind would be the worse trade.
--
-- SECURITY INVOKER (the default) stays deliberate, as in 20260823120000: app_events and
-- app_events_daily have RLS and no policies, so these functions cannot become a read hole.

DROP FUNCTION IF EXISTS analytics_daily_events(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS analytics_events_by_app(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS analytics_platform_clicks(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS analytics_streaming_services(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS analytics_search_success(TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION analytics_daily_events(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (day DATE, event_type TEXT, events BIGINT) AS $$
  SELECT d.day, d.event_type, sum(d.c)::bigint
  FROM (
    SELECT r.day AS day, r.event_type AS event_type, r.count AS c
    FROM app_events_daily r
    WHERE r.context_key IS NULL
      AND r.event_type IN ('search', 'platform_click', 'extension_activated')
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
      AND r.day < (p_until AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT (e.created_at AT TIME ZONE 'UTC')::date, e.event_type, count(*)
    FROM app_events e
    WHERE e.event_type IN ('search', 'platform_click', 'extension_activated')
      AND e.created_at >= p_since
      AND e.created_at < p_until
    GROUP BY 1, 2
  ) d
  GROUP BY d.day, d.event_type;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION analytics_events_by_app(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (app TEXT, event_type TEXT, events BIGINT) AS $$
  SELECT a.app, a.event_type, sum(a.c)::bigint
  FROM (
    SELECT r.app AS app, r.event_type AS event_type, r.count AS c
    FROM app_events_daily r
    WHERE r.context_key IS NULL
      AND r.event_type IN ('search', 'platform_click')
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
      AND r.day < (p_until AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT e.app, e.event_type, count(*)
    FROM app_events e
    WHERE e.event_type IN ('search', 'platform_click')
      AND e.created_at >= p_since
      AND e.created_at < p_until
    GROUP BY 1, 2
  ) a
  GROUP BY a.app, a.event_type;
$$ LANGUAGE sql STABLE;

-- Counts of one context key's values, per event type and app. Events without the key are left
-- out, as the functions this replaces did, so a client can derive "not recorded" by subtracting
-- from analytics_events_by_app. Values arrive as text on both sides: the rollup stored them
-- with jsonb_each_text, and ->> spells them the same way.
CREATE OR REPLACE FUNCTION analytics_context_counts(
  p_since TIMESTAMPTZ,
  p_until TIMESTAMPTZ,
  p_event_types TEXT[],
  p_key TEXT
)
RETURNS TABLE (event_type TEXT, app TEXT, value TEXT, events BIGINT) AS $$
  SELECT c.event_type, c.app, c.value, sum(c.c)::bigint
  FROM (
    SELECT r.event_type AS event_type, r.app AS app, r.context_value AS value, r.count AS c
    FROM app_events_daily r
    WHERE r.event_type = ANY (p_event_types)
      AND r.context_key = p_key
      AND r.context_value IS NOT NULL
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
      AND r.day < (p_until AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT e.event_type, e.app, e.context->>p_key, count(*)
    FROM app_events e
    WHERE e.event_type = ANY (p_event_types)
      AND e.created_at >= p_since
      AND e.created_at < p_until
      AND e.context->>p_key IS NOT NULL
    GROUP BY 1, 2, 3
  ) c
  GROUP BY c.event_type, c.app, c.value
  ORDER BY 4 DESC;
$$ LANGUAGE sql STABLE;

-- Unchanged apart from the end date; see 20260919120000 for why `completed` counts only events
-- carrying a has_results key.
CREATE OR REPLACE FUNCTION analytics_search_success(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (completed BIGINT, with_results BIGINT) AS $$
  SELECT
    (SELECT coalesce(sum(r.count), 0)
     FROM app_events_daily r
     WHERE r.event_type = 'search'
       AND r.context_key = 'has_results'
       AND r.day >= (p_since AT TIME ZONE 'UTC')::date
       AND r.day < (p_until AT TIME ZONE 'UTC')::date)
      + count(*) FILTER (WHERE jsonb_exists(e.context, 'has_results')) AS completed,
    (SELECT coalesce(sum(r.count), 0)
     FROM app_events_daily r
     WHERE r.event_type = 'search'
       AND r.context_key = 'has_results'
       AND r.context_value = 'true'
       AND r.day >= (p_since AT TIME ZONE 'UTC')::date
       AND r.day < (p_until AT TIME ZONE 'UTC')::date)
      + count(*) FILTER (WHERE e.context->'has_results' = 'true'::jsonb) AS with_results
  FROM app_events e
  WHERE e.event_type = 'search'
    AND e.created_at >= p_since
    AND e.created_at < p_until;
$$ LANGUAGE sql STABLE;

-- Supabase grants EXECUTE on new public functions directly to anon and authenticated, so a
-- PUBLIC revoke alone is not enough (20260919140000_revoke-anon-function-execute.sql).
REVOKE EXECUTE ON FUNCTION analytics_daily_events(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION analytics_events_by_app(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION analytics_context_counts(TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION analytics_search_success(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION analytics_daily_events(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION analytics_events_by_app(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION analytics_context_counts(TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION analytics_search_success(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION analytics_daily_events(TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Per-UTC-day counts of search / platform_click / extension_activated in [since, until), for /admin/analytics.';
COMMENT ON FUNCTION analytics_events_by_app(TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Search and click counts per client app in [since, until), for /admin/analytics.';
COMMENT ON FUNCTION analytics_context_counts(TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT) IS
  'Counts of one context key''s values per event type and app in [since, until), most first, for /admin/analytics.';
COMMENT ON FUNCTION analytics_search_success(TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Completed searches and how many returned results in [since, until); the /admin/analytics success rate.';
