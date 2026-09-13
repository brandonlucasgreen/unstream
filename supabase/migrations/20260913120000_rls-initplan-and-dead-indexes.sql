-- Disk I/O round 5 hygiene: evaluate auth.uid() once per statement, and drop six dead indexes.
--
-- Both halves come from Supabase's performance advisor, checked against the code in
-- docs/specs/supabase-disk-io-investigation.md ("Round 5"). Neither moves the disk I/O budget —
-- every table here is kilobytes, and no production query runs under RLS (everything goes through
-- the service-role client; the anon key is used only for auth.getUser). This lands so the advisor
-- stops reporting them and the next diagnosis isn't cluttered with findings that don't matter.
--
-- ── RLS: `auth.uid()` → `(select auth.uid())` ──────────────────────────────────────────────────
--
-- Written bare, `auth.uid()` is re-evaluated for every row the policy filters. Wrapped in a
-- scalar subquery it becomes an InitPlan the planner evaluates once per statement. The policies
-- are otherwise recreated exactly as they were: same names, same commands, USING-only where they
-- were USING-only (Postgres applies USING as the WITH CHECK for UPDATE when none is given). Each
-- is dropped and recreated rather than ALTERed so the file is idempotent.

-- saved_artists (migration 20260529120000)
DROP POLICY IF EXISTS "Users can view own saved artists" ON saved_artists;
CREATE POLICY "Users can view own saved artists"
  ON saved_artists FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own saved artists" ON saved_artists;
CREATE POLICY "Users can insert own saved artists"
  ON saved_artists FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own saved artists" ON saved_artists;
CREATE POLICY "Users can update own saved artists"
  ON saved_artists FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own saved artists" ON saved_artists;
CREATE POLICY "Users can delete own saved artists"
  ON saved_artists FOR DELETE
  USING ((select auth.uid()) = user_id);

-- usernames (migration 20260627140000)
DROP POLICY IF EXISTS "Users can read own username" ON public.usernames;
CREATE POLICY "Users can read own username"
  ON public.usernames FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own username" ON public.usernames;
CREATE POLICY "Users can insert own username"
  ON public.usernames FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own username" ON public.usernames;
CREATE POLICY "Users can update own username"
  ON public.usernames FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own username" ON public.usernames;
CREATE POLICY "Users can delete own username"
  ON public.usernames FOR DELETE
  USING ((select auth.uid()) = user_id);

-- release_feed_tokens (migration 20260802000000)
DROP POLICY IF EXISTS "Users can view own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can view own feed token"
  ON public.release_feed_tokens FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can create own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can create own feed token"
  ON public.release_feed_tokens FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can rotate own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can rotate own feed token"
  ON public.release_feed_tokens FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can revoke own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can revoke own feed token"
  ON public.release_feed_tokens FOR DELETE
  USING ((select auth.uid()) = user_id);

-- notification_preferences (migration 20260808120000)
DROP POLICY IF EXISTS "Users can view own notification preferences" ON notification_preferences;
CREATE POLICY "Users can view own notification preferences"
  ON notification_preferences FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own notification preferences" ON notification_preferences;
CREATE POLICY "Users can insert own notification preferences"
  ON notification_preferences FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own notification preferences" ON notification_preferences;
CREATE POLICY "Users can update own notification preferences"
  ON notification_preferences FOR UPDATE
  USING ((select auth.uid()) = user_id);

-- collection_items (migration 20260809120000). Still no INSERT policy, deliberately: rows are
-- written only by server code through the service-role client.
DROP POLICY IF EXISTS "Users can view own collection items" ON collection_items;
CREATE POLICY "Users can view own collection items"
  ON collection_items FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own collection items" ON collection_items;
CREATE POLICY "Users can update own collection items"
  ON collection_items FOR UPDATE
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own collection items" ON collection_items;
CREATE POLICY "Users can delete own collection items"
  ON collection_items FOR DELETE
  USING ((select auth.uid()) = user_id);

-- listening_signals (migration 20260809120000). Still no INSERT/UPDATE policies, deliberately.
DROP POLICY IF EXISTS "Users can view own listening signals" ON listening_signals;
CREATE POLICY "Users can view own listening signals"
  ON listening_signals FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own listening signals" ON listening_signals;
CREATE POLICY "Users can delete own listening signals"
  ON listening_signals FOR DELETE
  USING ((select auth.uid()) = user_id);

-- verification_requests (migration 20260411000000; the service-role policy was dropped in
-- 20260808160000 and is not recreated here).
DROP POLICY IF EXISTS "Users can read own verification requests" ON verification_requests;
CREATE POLICY "Users can read own verification requests"
  ON verification_requests FOR SELECT
  USING ((select auth.uid()) = user_id);

-- artist_profiles (migration 20260401000000; the public and service policies were dropped in
-- 20260808160000 and are not recreated here).
DROP POLICY IF EXISTS "Owner read own profile" ON artist_profiles;
CREATE POLICY "Owner read own profile"
  ON artist_profiles FOR SELECT
  USING ((select auth.uid()) = user_id);

-- artist_analytics (migration 20260401150000)
DROP POLICY IF EXISTS "Artists can read own analytics" ON artist_analytics;
CREATE POLICY "Artists can read own analytics"
  ON artist_analytics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM artist_profiles
      WHERE artist_profiles.artist_id = artist_analytics.artist_id
        AND artist_profiles.user_id = (select auth.uid())
        AND artist_profiles.verified_at IS NOT NULL
    )
  );

-- ── Dead indexes ───────────────────────────────────────────────────────────────────────────────
--
-- Each one is a write on every insert or update to its table and serves no query. Why each is
-- safe to drop, from the code:
--
-- * idx_saved_artists_user_id (user_id): a strict prefix of saved_artists_user_slug_unique,
--   idx_saved_artists_user_last_modified and idx_saved_artists_user_deleted, any of which the
--   planner uses for a user_id lookup.
-- * idx_saved_artists_user_artist (user_id, artist_id): built for the (user_id, artist_id) key
--   that migration 014 replaced with (user_id, artist_slug). Every query since keys on the slug.
-- * idx_merge_overrides_urls (GIN on platform_urls): getMergeOverrides reads the whole table into
--   a 60-second in-process memo and matches in JavaScript; nothing queries containment.
-- * idx_release_catalog_state_catalogued (last_catalogued_at): the cooldown is evaluated in
--   JavaScript, either over the whole table (getStaleCatalogCandidates) or after a primary-key
--   lookup (claimArtistForCatalog). idx_release_catalog_state_attempted stays — the hourly-cap
--   count filters on last_attempted_at.
-- * idx_release_feed_tokens_token: `token` is UNIQUE, which already indexes it; the creating
--   migration's own comment says as much.
-- * idx_email_log_created_at: email_log is written by sendNotificationOnce (an insert and an
--   update by primary key) and read by nothing; the dedup unique index does the real work.
--
-- Kept, despite the advisor listing them as unused: idx_api_keys_prefix matches
-- authenticateApiKey's (key_prefix, is_active = true) lookup exactly — zero scans means zero
-- authenticated v1 calls since the stats reset, not a dead index; idx_listening_signals_user
-- serves me-listening's user_id filter on a table small enough that the planner seq-scans today.
--
-- Not added, despite the advisor recommending them: indexes on saved_artists.artist_id and
-- verification_requests.user_id. Both tables are one or two heap pages, so a sequential scan is
-- a single cached block and an index would be pure write cost.
--
-- Not CONCURRENTLY, for the same reason as 20260906120000: the CLI applies each migration inside
-- a transaction, and these tables are small enough that the lock lasts milliseconds.

DROP INDEX IF EXISTS idx_saved_artists_user_id;
DROP INDEX IF EXISTS idx_saved_artists_user_artist;
DROP INDEX IF EXISTS idx_merge_overrides_urls;
DROP INDEX IF EXISTS idx_release_catalog_state_catalogued;
DROP INDEX IF EXISTS idx_release_feed_tokens_token;
DROP INDEX IF EXISTS idx_email_log_created_at;
