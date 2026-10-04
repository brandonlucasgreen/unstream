-- Close the direct PostgREST write path on account tables.
--
-- These tables kept owner-scoped INSERT/UPDATE/DELETE policies from when the browser might
-- have written them directly. Nothing does: the web app, the Apple app and the extension
-- only call /auth/v1, and every write goes through a Netlify function on the service-role
-- client (which bypasses RLS and these grants). So the policies served no client, but they
-- let any signed-in user skip the server's validation with a curl against /rest/v1:
--
--   collection_items     rewrite title/artist_name/release_id/artist_slug, so a public /u/
--                        page shows "purchased" records never bought, and artist_slug feeds
--                        the catalogue sweep's demand gate. me-collection.ts only flips `hidden`.
--   usernames            claim a reserved handle ("support", "admin") with sharing on, skipping
--                        isReservedHandle and the location length limit.
--   saved_artists        unlimited rows with any artist_id/name/image, skipping the rate limit.
--   release_feed_tokens  choose one's own (guessable) private feed token.
--   notification_preferences, listening_signals: same shape, no server check to skip but no
--                        client either.
--
-- Owner-only SELECT policies are left as they were.

REVOKE INSERT, UPDATE, DELETE ON saved_artists FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.usernames FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.release_feed_tokens FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON notification_preferences FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON collection_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON listening_signals FROM anon, authenticated;

DROP POLICY IF EXISTS "Users can insert own saved artists" ON saved_artists;
DROP POLICY IF EXISTS "Users can update own saved artists" ON saved_artists;
DROP POLICY IF EXISTS "Users can delete own saved artists" ON saved_artists;

DROP POLICY IF EXISTS "Users can insert own username" ON public.usernames;
DROP POLICY IF EXISTS "Users can update own username" ON public.usernames;
DROP POLICY IF EXISTS "Users can delete own username" ON public.usernames;

DROP POLICY IF EXISTS "Users can create own feed token" ON public.release_feed_tokens;
DROP POLICY IF EXISTS "Users can rotate own feed token" ON public.release_feed_tokens;
DROP POLICY IF EXISTS "Users can revoke own feed token" ON public.release_feed_tokens;

DROP POLICY IF EXISTS "Users can insert own notification preferences" ON notification_preferences;
DROP POLICY IF EXISTS "Users can update own notification preferences" ON notification_preferences;

DROP POLICY IF EXISTS "Users can update own collection items" ON collection_items;
DROP POLICY IF EXISTS "Users can delete own collection items" ON collection_items;

DROP POLICY IF EXISTS "Users can delete own listening signals" ON listening_signals;

-- Hardening: both are SECURITY DEFINER without a pinned search_path. Neither is callable
-- outside the service role since 20260919140000, so this closes a latent gap, not a live one.
ALTER FUNCTION public.increment_analytics(uuid, date, text) SET search_path = public;
ALTER FUNCTION public.increment_analytics_batch(uuid[], date, text) SET search_path = public;
