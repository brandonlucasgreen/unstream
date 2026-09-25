-- Migration: platform clicks by app, for the tips demand test's "Patronage clicks" panel
--
-- docs/specs/artist-tips-spec.md §9 Phase 0 asks whether fans click an artist's existing
-- patronage links (Ko-fi, Patreon, Buy Me a Coffee, Liberapay) at the listening moment — the
-- Mac popover and the extension popup — before anything native is built. The dashboard already
-- counts clicks by platform and clicks by app, but not the two together, and "how many Ko-fi
-- clicks came from the extension" is exactly the question.
--
-- The caller passes the platform ids to count. Which platforms are "patronage" is decided by
-- api/shared/platform-registry.ts, not here, so a platform added to that category is counted
-- without a migration. Passing the set also keeps the result tiny (apps x patronage platforms,
-- a dozen rows), well under PostgREST's 1,000-row cap.
--
-- Reads `rollup UNION raw` like the other analytics_* functions (20260919120000). The pairing
-- survives the rollup: app_events_daily keeps `app` as a column on every row, and each event's
-- platform as its own context_key='platform' row, so (app, platform) is answerable at daily
-- granularity forever. What does not survive is platform combined with a *second* context key,
-- since the rollup stores each key on its own row — so a future "which screen" split must be
-- carried by `app` or read within the 90-day raw window. The dashboard passes a 30-day cutoff,
-- which raw answers alone; the rollup side is the same future-proofing the siblings carry.
--
-- SECURITY INVOKER (the default), as with its siblings: both tables are RLS-enabled with no
-- policies, so this cannot become a read hole.

CREATE OR REPLACE FUNCTION analytics_platform_clicks_by_app(p_since TIMESTAMPTZ, p_platforms TEXT[])
RETURNS TABLE (app TEXT, platform TEXT, clicks BIGINT) AS $$
  SELECT c.app, c.platform, sum(c.n)::bigint
  FROM (
    SELECT r.app AS app, r.context_value AS platform, r.count AS n
    FROM app_events_daily r
    WHERE r.event_type = 'platform_click'
      AND r.context_key = 'platform'
      AND r.context_value = ANY (p_platforms)
      AND r.day >= (p_since AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT e.app, e.context->>'platform', count(*)
    FROM app_events e
    WHERE e.event_type = 'platform_click'
      AND e.created_at >= p_since
      AND e.context->>'platform' = ANY (p_platforms)
    GROUP BY 1, 2
  ) c
  GROUP BY c.app, c.platform
  ORDER BY 3 DESC;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION analytics_platform_clicks_by_app(TIMESTAMPTZ, TEXT[]) IS
  'Platform click counts per client app since a cutoff, for the given platform ids; the /admin/analytics "Patronage clicks" panel.';

-- The standing rule (CLAUDE.md, security practices): Supabase grants EXECUTE on new public
-- functions to PUBLIC, and on older default privileges directly to anon and authenticated, so
-- revoke from all three and rely on the service role.
REVOKE EXECUTE ON FUNCTION analytics_platform_clicks_by_app(TIMESTAMPTZ, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION analytics_platform_clicks_by_app(TIMESTAMPTZ, TEXT[]) TO service_role;
