-- Migration 022: Public sharing of saved artists list (UNS-31 PR 2)
-- Adds user_public_ids table and saved_artists_public column to public.usernames.
-- Depends on migration 021 (public.usernames table).

-- Add saved_artists_public flag to the existing usernames table.
-- Default false — users must explicitly opt in to sharing.
ALTER TABLE public.usernames
  ADD COLUMN IF NOT EXISTS saved_artists_public BOOLEAN NOT NULL DEFAULT false;

-- Create user_public_ids table.
-- Presence of a row = user has opted into public sharing.
-- public_handle mirrors usernames.username but is kept in a separate table for:
--   - explicit sharing opt-in semantics (row existence = opted in)
--   - cleaner RLS (this table is the public-readable surface)
--   - future flexibility (share history, multiple handles, revocation)
CREATE TABLE IF NOT EXISTS public.user_public_ids (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_handle TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for public lookups by handle (the public endpoint queries this)
CREATE INDEX IF NOT EXISTS idx_user_public_ids_public_handle
  ON public.user_public_ids(public_handle);

-- Format constraint: same as usernames.username (3-20 chars, lowercase alphanumeric + hyphens)
ALTER TABLE public.user_public_ids DROP CONSTRAINT IF EXISTS public_handle_format;
ALTER TABLE public.user_public_ids ADD CONSTRAINT public_handle_format
  CHECK (public_handle ~ '^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$');

-- Reserved-handle constraint: prevents reserved words from being used as public handles.
-- Uses NOT (handle = ANY(ARRAY[...])) pattern for a single, readable constraint.
ALTER TABLE public.user_public_ids DROP CONSTRAINT IF EXISTS public_handle_not_reserved;
ALTER TABLE public.user_public_ids ADD CONSTRAINT public_handle_not_reserved
  CHECK (NOT (public_handle = ANY(ARRAY[
    'admin', 'api', 'settings', 'login', 'signup', 'signin', 'register',
    'logout', 'support', 'about', 'privacy', 'terms', 'dashboard',
    'u', 'a', 'artist', 'www', 'mail', 'ftp', 'root', 'help', 'docs',
    'status', 'blog'
  ])));

-- RLS: user_public_ids is read-only for anon and authenticated.
-- Only the public_handle column is publicly readable; user_id is never exposed
-- to clients (the service role key bypasses RLS for server-side joins).
ALTER TABLE public.user_public_ids ENABLE ROW LEVEL SECURITY;

-- Anyone can read public_handle (needed for the public sharing endpoint and edge function).
-- We expose only public_handle — the API layer joins through usernames to get saved artists.
DROP POLICY IF EXISTS "Anyone can read public handles" ON public.user_public_ids;
CREATE POLICY "Anyone can read public handles"
  ON public.user_public_ids FOR SELECT
  USING (true);

-- Owner can insert their own row (opt into sharing)
DROP POLICY IF EXISTS "Users can insert own public id" ON public.user_public_ids;
CREATE POLICY "Users can insert own public id"
  ON public.user_public_ids FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Owner can update their own row (rename handle)
DROP POLICY IF EXISTS "Users can update own public id" ON public.user_public_ids;
CREATE POLICY "Users can update own public id"
  ON public.user_public_ids FOR UPDATE
  USING (auth.uid() = user_id);

-- Owner can delete their own row (opt out of sharing)
DROP POLICY IF EXISTS "Users can delete own public id" ON public.user_public_ids;
CREATE POLICY "Users can delete own public id"
  ON public.user_public_ids FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.user_public_ids IS 'Maps users to public handles for saved-artists sharing (UNS-31 PR 2). Row existence = opted into sharing.';
COMMENT ON COLUMN public.usernames.saved_artists_public IS 'Whether the user has enabled public sharing of their saved artists list (UNS-31 PR 2).';