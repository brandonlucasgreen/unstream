-- Capture get_artist_analytics in a migration.
--
-- It was created via the Supabase dashboard before migrations tracked the analytics
-- functions, so it existed in production with no definition in this repo — the one
-- piece of production-only schema drift left after disk I/O round 6 (2026-09-19).
-- Called only by api/functions/analytics-stats.ts through the service role
-- (getClient() in db.ts), for the artist dashboard's analytics view.
--
-- SECURITY DEFINER: it reads artist_analytics with the caller's (postgres) privileges.
-- search_path is pinned here even though production's dashboard-created definition
-- never pinned it — an unpinned SECURITY DEFINER function can be made to resolve
-- artist_analytics from a hostile schema earlier in the path, and CREATE OR REPLACE
-- reconciles the drift the same moment the definition is captured.
--
-- Idempotent: CREATE OR REPLACE re-applies cleanly, and the revokes/grants are no-ops
-- when already held.

CREATE OR REPLACE FUNCTION public.get_artist_analytics(p_artist_id uuid, p_since date)
RETURNS TABLE(date date, metric text, count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
  BEGIN
    RETURN QUERY
    SELECT aa.date, aa.metric, aa.count
    FROM artist_analytics aa
    WHERE aa.artist_id = p_artist_id
      AND aa.date >= p_since
    ORDER BY aa.date ASC;
  END;
$function$;

-- The standing rule (CLAUDE.md, security practices): on Supabase, default privileges
-- grant EXECUTE directly to anon and authenticated, so a PUBLIC revoke alone leaves
-- both able to call this at /rest/v1/rpc/get_artist_analytics. Revoke from all three
-- and rely on the service role.
REVOKE EXECUTE ON FUNCTION public.get_artist_analytics(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_artist_analytics(uuid, date) TO service_role;