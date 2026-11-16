-- Pin search_path on the nine public functions that had none.
--
-- THIS IS A RECORD, NOT A NEW CHANGE. It was applied to production directly on 2026-11-09
-- (19:26 UTC), not through this repo, so production's migration history held a version the repo
-- lacked. `supabase db push` refuses to apply anything in that state, which would have blocked
-- the next migration merged to main (CLAUDE.md, "Database / migrations"), and the Supabase
-- Preview check was red on every commit from that day. The statements below are the ones
-- production recorded, recovered from supabase_migrations.schema_migrations on 2026-11-16.
-- Because the version is already in production's history, the migrate workflow skips this file
-- there; it only runs when the migrations are replayed from the baseline (a preview branch, a
-- local stack).
--
-- The filename keeps production's own name for it, underscores and all, rather than this
-- folder's hyphens, so the two records read the same.
--
-- What it does: a function with no search_path of its own resolves unqualified names (tables,
-- other functions) through the caller's, so a caller able to create objects in a schema ahead of
-- `public` could have the function pick up theirs instead. Fixing it to `public, pg_temp` closes
-- that, with pg_temp last so a temporary table can't shadow a real one. Every other function in
-- `public` already set its own.
--
-- CREATE OR REPLACE FUNCTION resets this: Postgres keeps only ownership and grants across a
-- replace. A later migration that redefines one of these must carry `SET search_path` in its own
-- definition, or it silently undoes the pin.

ALTER FUNCTION public.update_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_saved_artists_bump_last_modified() SET search_path = public, pg_temp;
ALTER FUNCTION public.check_api_key_limit() SET search_path = public, pg_temp;
ALTER FUNCTION public.gc_saved_artists_tombstones() SET search_path = public, pg_temp;
ALTER FUNCTION public.rollup_app_events() SET search_path = public, pg_temp;
ALTER FUNCTION public.analytics_daily_events(timestamptz, timestamptz) SET search_path = public, pg_temp;
ALTER FUNCTION public.analytics_events_by_app(timestamptz, timestamptz) SET search_path = public, pg_temp;
ALTER FUNCTION public.analytics_search_success(timestamptz, timestamptz) SET search_path = public, pg_temp;
ALTER FUNCTION public.analytics_context_counts(timestamptz, timestamptz, text[], text) SET search_path = public, pg_temp;
