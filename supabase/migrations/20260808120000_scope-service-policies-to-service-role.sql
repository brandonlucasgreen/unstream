-- Migration: stop "Service …" policies from granting access to anon
--
-- Several policies written early on are named for the service role but never say so. A
-- CREATE POLICY with no TO clause applies to PUBLIC, and PUBLIC includes `anon` — the role a
-- request carrying the public anon key runs as. The anon key ships in the client bundle, so
-- every one of these policies was readable and writable by anyone.
--
-- Reproduced against a local Postgres with Supabase's role model before writing this:
--   * read every verified artist's claim email from artist_profiles
--   * read, update and delete verification_requests (email + free-text message)
--   * set artist_profiles.verified_at — self-verification
--   * rename or relink any artist in the catalogue
--   * insert merge overrides, which steer search disambiguation
--
-- The fix is to delete the policies rather than rewrite them with `TO service_role`, because
-- the service role has BYPASSRLS: it never consulted them in the first place. They granted
-- nothing to the role they were named for and everything to the role they forgot to exclude.
--
-- 20260731120000_releases.sql already had this right, and says so:
--   "Writes are service-role only. The service key bypasses RLS, so the absence of
--    insert/update/delete policies is what keeps anon and authenticated clients read-only —
--    deliberate, not an oversight."
-- That is the model. This migration brings the older tables in line with it.
--
-- Safe to apply: nothing outside the server talks to PostgREST. The web app and the Apple apps
-- go through api/functions/*, which use SUPABASE_SERVICE_KEY; the edge functions use the
-- service key directly; the browser extension only ever calls /auth/v1. Every anon-key client
-- in api/functions/ exists solely to call auth.getUser() and never touches a table.
--
-- Genuinely public reads are kept: the artist catalogue is the data the site renders anyway.

-- ── artist_profiles ─────────────────────────────────────────────────────────
-- RLS is row-level, not column-level (the lesson from migration 023), so a policy letting anon
-- read verified profile rows exposed `email` along with the bio and links it was meant for. The
-- public artist page is rendered server-side from the service-role client and never needed it.
DROP POLICY IF EXISTS "Public read verified profiles" ON artist_profiles;
DROP POLICY IF EXISTS "Service insert profiles" ON artist_profiles;
DROP POLICY IF EXISTS "Service update profiles" ON artist_profiles;
-- "Owner read own profile" (auth.uid() = user_id) stays: correctly scoped, and harmless.

-- ── verification_requests ───────────────────────────────────────────────────
-- The worst of them: FOR ALL USING (true) WITH CHECK (true) on a table of email addresses and
-- free-text claim messages, so anon could read, alter, approve and delete every row.
DROP POLICY IF EXISTS "Service role full access" ON verification_requests;
-- "Users can read own verification requests" stays.

-- ── artists / artist_links ──────────────────────────────────────────────────
-- Not a disclosure — this data is public by design — but anon could rewrite or delete the
-- catalogue. Reads stay open, writes go back to the service role.
DROP POLICY IF EXISTS "Service insert" ON artists;
DROP POLICY IF EXISTS "Service update" ON artists;
DROP POLICY IF EXISTS "Service insert" ON artist_links;
DROP POLICY IF EXISTS "Service update" ON artist_links;
DROP POLICY IF EXISTS "Service delete" ON artist_links;

-- ── artist_merge_overrides ──────────────────────────────────────────────────
-- Migration 005's comment ("so the anon key, used by Netlify functions, can also read
-- overrides") describes a wiring that no longer exists — the functions read with the service
-- key. The read policy is harmless and stays; the insert policy let anyone corrupt search
-- disambiguation by merging unrelated artists together.
DROP POLICY IF EXISTS "Allow service role insert" ON artist_merge_overrides;

-- ── app_events ──────────────────────────────────────────────────────────────
-- analytics-app-event.ts records events with the service-role client, so the anon insert policy
-- has no consumer; all it offered was a way to flood the product analytics with invented events.
DROP POLICY IF EXISTS "Public insert app events" ON app_events;

-- ── Defence in depth ────────────────────────────────────────────────────────
-- Dropping the policies is the fix — an RLS-enabled table with no matching policy denies by
-- default. Revoking the underlying grants means a future permissive policy, or RLS being
-- switched off by accident, doesn't silently reopen write access. api_keys (migration 007) has
-- always done this; these tables should have too.
--
-- Note Supabase sets ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated, so
-- every new table starts life with these grants. New tables holding anything private want the
-- same two lines.
REVOKE INSERT, UPDATE, DELETE ON artist_profiles FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON verification_requests FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON artists FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON artist_links FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON artist_merge_overrides FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON app_events FROM anon, authenticated;

-- SELECT grants are deliberately left in place: the remaining read policies (public catalogue
-- data, and owner-scoped reads on artist_profiles and verification_requests) need them, and
-- those policies are correctly scoped.

COMMENT ON TABLE verification_requests IS
  'Manual-review artist claims. Holds an email address and free-text message — service-role writes only; the sole policy is an owner-scoped read.';
COMMENT ON TABLE artist_profiles IS
  'Claimed artist profiles. Contains the claimant''s email, so there is deliberately no public read policy — public artist pages render server-side with the service-role client.';
