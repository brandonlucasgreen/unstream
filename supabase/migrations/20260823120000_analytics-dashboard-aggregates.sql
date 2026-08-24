-- Migration: aggregate the admin dashboard's analytics in Postgres, not in JS
--
-- `/admin/analytics` was reporting numbers that were wrong by more than 16x, and reporting them
-- confidently. Measured against production on 2026-08-23:
--
--   searches_30d (count: 'exact')              10,380
--   searches summed from the 30-day chart          641
--   by_app searches + clicks                 exactly 1000
--   streaming_services activations           exactly 1000
--   days with any data in the chart            4 of 30
--
-- Cause is the PostgREST 1,000-row cap. Four of the endpoint's queries pulled raw `app_events`
-- rows and counted them in a JS loop; PostgREST silently returned the first 1,000 and stopped.
-- The two "exactly 1000" totals are the tell.
--
-- The daily chart was the worst of it because its query ordered `created_at` ASCENDING, so the
-- surviving 1,000 rows were the OLDEST in the window: every bar sat at the far left of the chart
-- and the most recent 26 days rendered as zero. Truncation that looks like a data outage.
--
-- Paging the rows instead (readAllPages) would fix the arithmetic and make the Disk IO Budget
-- problem worse — 10,000+ rows shipped out of Postgres on every dashboard load, to be counted
-- one at a time in a serverless function. Counting in Postgres reads the same index ranges and
-- returns ~40 rows total.
--
-- These all filter `event_type` then range-scan `created_at`, which is exactly what
-- idx_app_events_type_created (2026-08-11) was added to serve.
--
-- The window start is passed in rather than computed here on purpose: the endpoint already owns
-- the definition of "last 30 days" (and pre-fills every day in the range so gaps render as zero),
-- so the SQL stays dumb and the two can't disagree about the boundary.

-- Buckets by UTC date to match what the endpoint did with the raw rows, which was
-- `row.created_at.split('T')[0]` on an ISO-8601 UTC string. `created_at::date` would silently
-- follow the session TimeZone instead.
CREATE OR REPLACE FUNCTION analytics_daily_events(p_since TIMESTAMPTZ)
RETURNS TABLE (day DATE, event_type TEXT, events BIGINT) AS $$
  SELECT (e.created_at AT TIME ZONE 'UTC')::date, e.event_type, count(*)
  FROM app_events e
  WHERE e.event_type IN ('search', 'platform_click', 'extension_activated')
    AND e.created_at >= p_since
  GROUP BY 1, 2;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION analytics_events_by_app(p_since TIMESTAMPTZ)
RETURNS TABLE (app TEXT, event_type TEXT, events BIGINT) AS $$
  SELECT e.app, e.event_type, count(*)
  FROM app_events e
  WHERE e.event_type IN ('search', 'platform_click')
    AND e.created_at >= p_since
  GROUP BY 1, 2;
$$ LANGUAGE sql STABLE;

-- Rows whose context carries no platform were skipped by the JS loop; the WHERE clause here is
-- that same skip. Ordering is done in SQL so the endpoint's top-10 slice means something.
CREATE OR REPLACE FUNCTION analytics_platform_clicks(p_since TIMESTAMPTZ)
RETURNS TABLE (platform TEXT, clicks BIGINT) AS $$
  SELECT e.context->>'platform', count(*)
  FROM app_events e
  WHERE e.event_type = 'platform_click'
    AND e.created_at >= p_since
    AND e.context->>'platform' IS NOT NULL
  GROUP BY 1
  ORDER BY 2 DESC;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION analytics_streaming_services(p_since TIMESTAMPTZ)
RETURNS TABLE (service TEXT, activations BIGINT) AS $$
  SELECT e.context->>'streaming_service', count(*)
  FROM app_events e
  WHERE e.event_type = 'extension_activated'
    AND e.created_at >= p_since
    AND e.context->>'streaming_service' IS NOT NULL
  GROUP BY 1
  ORDER BY 2 DESC;
$$ LANGUAGE sql STABLE;

-- Success rate. `completed` counts only events carrying a has_results key, which is how the
-- endpoint separates a completed search from the context-free initiation events written before
-- 2026-08-19 — both sides of the ratio exclude those. jsonb_exists() is the `?` operator spelled
-- out, and comparing against 'true'::jsonb matches a JSON boolean specifically, so a string
-- "true" is not counted — the same thing `=== true` did in JS.
CREATE OR REPLACE FUNCTION analytics_search_success(p_since TIMESTAMPTZ)
RETURNS TABLE (completed BIGINT, with_results BIGINT) AS $$
  SELECT
    count(*) FILTER (WHERE jsonb_exists(e.context, 'has_results')),
    count(*) FILTER (WHERE e.context->'has_results' = 'true'::jsonb)
  FROM app_events e
  WHERE e.event_type = 'search'
    AND e.created_at >= p_since;
$$ LANGUAGE sql STABLE;

-- SECURITY INVOKER (the default) is deliberate. app_events has RLS enabled and no policies at
-- all — service-role reads bypass RLS, everyone else gets nothing — so these functions inherit
-- that and cannot become a read hole in it. SECURITY DEFINER would turn each one into exactly
-- that, since PostgREST exposes every public-schema function at /rest/v1/rpc/<name>.
--
-- EXECUTE is granted to PUBLIC by default on a new function, so revoking is not optional here.
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

COMMENT ON FUNCTION analytics_daily_events(TIMESTAMPTZ) IS
  'Per-UTC-day counts of search / platform_click / extension_activated since a cutoff, for /admin/analytics.';
COMMENT ON FUNCTION analytics_events_by_app(TIMESTAMPTZ) IS
  'Search and click counts per client app since a cutoff, for /admin/analytics.';
COMMENT ON FUNCTION analytics_platform_clicks(TIMESTAMPTZ) IS
  'Platform click counts since a cutoff, most-clicked first, for /admin/analytics.';
COMMENT ON FUNCTION analytics_streaming_services(TIMESTAMPTZ) IS
  'Extension activation counts per streaming service since a cutoff, most-active first, for /admin/analytics.';
COMMENT ON FUNCTION analytics_search_success(TIMESTAMPTZ) IS
  'Completed searches and how many returned results since a cutoff; the /admin/analytics success rate.';
