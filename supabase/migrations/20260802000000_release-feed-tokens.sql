-- Migration: per-fan release feed tokens
--
-- Backs /feed/f/{token}.ics and /feed/f/{token}.xml — one private, subscribable calendar/feed
-- of upcoming releases across everything a fan has saved (spec §3).
--
-- WHY A TOKEN IN THE URL AT ALL: calendar clients cannot authenticate. Apple Calendar and
-- Google Calendar fetch a URL on a schedule with no OAuth, no bearer header and no cookies. An
-- opaque, unguessable, rotatable path token is therefore the only workable private feed, and it
-- is the same design Google and Apple use for their own "secret address" calendar exports.
--
-- WHY THE TOKEN IS STORED IN PLAINTEXT, unlike api_keys which are hashed:
-- a hashed token could never be shown to its owner again, and a calendar feed URL is something
-- the user has to be able to re-read and re-copy (new device, re-subscribing, moving clients).
-- api_keys can be hashed precisely because they are shown once and replaced when lost; this
-- cannot. It is still treated as a credential everywhere else: RLS restricts SELECT to the
-- owner, the serving function never logs it, and it must never reach analytics or Sentry.
--
-- Rotation, not just revocation, is the recovery path: a leaked feed URL is fixed by issuing a
-- new token, which instantly breaks every existing subscription to the old one.

CREATE TABLE IF NOT EXISTS public.release_feed_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One token per user. Rotation replaces the value in place rather than accumulating rows,
  -- so an old token stops working the moment a new one is issued.
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- The serving path's only query: token -> user. Unique already indexes it, named here so the
-- intent survives a future change to the constraint.
CREATE INDEX IF NOT EXISTS idx_release_feed_tokens_token ON public.release_feed_tokens(token);

ALTER TABLE public.release_feed_tokens ENABLE ROW LEVEL SECURITY;

-- Owner-only. The feed function itself reads with the service-role client (which bypasses RLS)
-- because an anonymous calendar client presents no session — the token *is* the authorization
-- there. These policies exist so that a signed-in user reading their own row from the browser
-- is safe, and so nobody else's row is ever reachable.
DROP POLICY IF EXISTS "Users can view own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can view own feed token"
  ON public.release_feed_tokens FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can create own feed token"
  ON public.release_feed_tokens FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can rotate own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can rotate own feed token"
  ON public.release_feed_tokens FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can revoke own feed token" ON public.release_feed_tokens;
CREATE POLICY "Users can revoke own feed token"
  ON public.release_feed_tokens FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.release_feed_tokens IS
  'Opaque path tokens for private release feeds (/feed/f/{token}.ics). Stored in plaintext because the owner must be able to re-read the URL; treat as a credential — never log it.';
