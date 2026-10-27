-- Curator posts: one Buffer OAuth connection per user (docs/specs/curator-posts-spec.md).
--
-- Server-only, like bandcamp_slug_probes: RLS is ENABLED with NO policies, deliberately. The
-- service-role client bypasses RLS and anon gets nothing, so the tokens are unreachable from the
-- browser even with a valid session. The missing policies are the point, not an oversight.
--
-- Both tokens are encrypted at rest by the application (api/functions/credential-crypto.ts), the
-- same way Bandcamp Subsonic credentials are. The columns hold ciphertext, never a bearer token.

CREATE TABLE IF NOT EXISTS public.buffer_connections (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Ciphertext from encryptCredential. An access token lives an hour; the refresh token is how
  -- a connection outlives that.
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,

  -- When the access token stops working. Every call refreshes before this, not after it.
  expires_at TIMESTAMPTZ NOT NULL,

  -- The Buffer organization the curator's channels belong to, and which of them they chose to
  -- let Unstream post to. An empty array means "they haven't picked yet", not "all of them".
  organization_id TEXT,
  selected_channel_ids TEXT[] NOT NULL DEFAULT '{}',

  -- Buffer's refresh tokens are SINGLE-USE: presenting an old one revokes the whole grant and
  -- silently disconnects the curator. This counter is bumped on every successful refresh and
  -- used as the compare-and-set guard, so two concurrent refreshes cannot both spend the same
  -- token — the loser sees its update affect zero rows and re-reads instead of calling Buffer.
  refresh_counter BIGINT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.buffer_connections IS
  'One Buffer OAuth connection per Unstream user. Server-only: RLS on with no policies, so only the service role can read it. Tokens are encrypted by the application.';

COMMENT ON COLUMN public.buffer_connections.refresh_counter IS
  'Compare-and-set guard for Buffer''s single-use refresh tokens. Reusing one revokes the grant, so only the writer whose counter matches may spend the stored refresh token.';

ALTER TABLE public.buffer_connections ENABLE ROW LEVEL SECURITY;

-- No policies, on purpose. See the table comment above.

-- Supabase grants EXECUTE/SELECT to anon and authenticated by default on new public objects, so
-- a PUBLIC revoke alone would leave both able to read this through PostgREST.
REVOKE ALL ON public.buffer_connections FROM PUBLIC, anon, authenticated;
