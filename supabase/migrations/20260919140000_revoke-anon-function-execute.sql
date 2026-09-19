-- Revoke EXECUTE on public-schema functions from anon and authenticated.
--
-- Why this exists: Supabase sets default privileges on the role that runs migrations
-- that grant EXECUTE on every new function in `public` DIRECTLY to `anon` and
-- `authenticated` (visible in proacl as `anon=X/postgres, authenticated=X/postgres`),
-- so the `REVOKE ... FROM PUBLIC` statements in 20260919120000_app-events-daily-rollup.sql
-- were necessary but not sufficient: both roles could still execute `rollup_app_events()`
-- — which deletes rows — and all five analytics_* functions at /rest/v1/rpc/<name>.
-- Confirmed in production on 2026-09-19 by spot-check after that migration applied.
--
-- The Docker validation harness could not catch this class: vanilla Postgres has no such
-- default privileges, so the rollup migration's anon-denial checks passed there while
-- production still granted anon directly. Any future function-security check must run
-- against the real database, not a throwaway one.
--
-- A blanket revoke is safe because nothing in this repo calls PostgREST RPC with the
-- anon or authenticated key: the SPA, the browser extension and the Apple app contain
-- no `.rpc(` call at all, and every `rpc()` in api/functions/ goes through getClient()
-- (db.ts), which holds the service role. Signed-in users' data access is table-level
-- (RLS) and unaffected by function EXECUTE privileges; trigger functions do not need
-- EXECUTE for their triggers to fire.
--
-- The loop, rather than a named list, is deliberate: `get_artist_analytics` exists in
-- production with no migration in this repo (created via the dashboard before migrations
-- tracked it; called only by api/functions/analytics-stats.ts via the service role), and
-- a named list would silently skip it.

DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
                   fn.oid::regprocedure);
  END LOOP;
END;
$$;

-- Close the door for functions created by future migrations, as far as Postgres allows:
-- the role that runs this migration is the role that runs them, and this strips Supabase's
-- anon/authenticated entries from the default ACL. It CANNOT revoke the built-in PUBLIC
-- EXECUTE grant on functions — default-privilege entries are additive, and a PUBLIC revoke
-- there is a no-op (verified: a function created after this ALTER still lands with `{=X}`
-- in its proacl). So anon still reaches future functions through PUBLIC, and **every
-- migration that creates a function must carry its own REVOKE ... FROM PUBLIC, anon,
-- authenticated** — that is the standing rule in CLAUDE.md's security practices, and this
-- migration is the one-time cleanup for everything that existed before it. The service_role
-- grant by default keeps backend calls working even when a migration forgets to add it.
-- Idempotent alongside the loop: REVOKE on a privilege not held is a no-op, so re-running
-- this migration (e.g. on a fresh branch database) is safe.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;

-- After the loop, who can call what in `public`: postgres (owner) and service_role,
-- nobody else. The service-role grants themselves live in the migrations that created
-- each function (e.g. 20260919120000_app-events-daily-rollup.sql) — nothing here
-- touches them, so they are not restated; naming them again would make this migration
-- fail on any database that predates the rollup, and the grants belong with their
-- functions anyway.