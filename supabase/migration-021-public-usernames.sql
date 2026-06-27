-- Migration 021: Create public.usernames table for user-chosen public handles (UNS-31 PR 1)
-- Replaces migration 020 which added a custom column to auth.users (unreadable via PostgREST).
-- Username is stored in a public table with RLS, FK to auth.users, UNIQUE + CHECK constraints.
-- Anon can read the username column (for the future public-sharing endpoint in PR 2).
-- Owner can read/write their own row.

CREATE TABLE IF NOT EXISTS public.usernames (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for public lookups by username (PR 2 public endpoint)
CREATE INDEX IF NOT EXISTS idx_usernames_username ON public.usernames(username);

-- Format constraint: 3-20 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen.
-- Drop first for re-runnability.
ALTER TABLE public.usernames DROP CONSTRAINT IF EXISTS username_format;
ALTER TABLE public.usernames ADD CONSTRAINT username_format
  CHECK (username ~ '^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$');

-- RLS: owner can read/write own row; anyone can read username column (for public sharing).
ALTER TABLE public.usernames ENABLE ROW LEVEL SECURITY;

-- Owner can read their own row
DROP POLICY IF EXISTS "Users can read own username" ON public.usernames;
CREATE POLICY "Users can read own username"
  ON public.usernames FOR SELECT
  USING (auth.uid() = user_id);

-- Owner can insert their own row
DROP POLICY IF EXISTS "Users can insert own username" ON public.usernames;
CREATE POLICY "Users can insert own username"
  ON public.usernames FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Owner can update their own row
DROP POLICY IF EXISTS "Users can update own username" ON public.usernames;
CREATE POLICY "Users can update own username"
  ON public.usernames FOR UPDATE
  USING (auth.uid() = user_id);

-- Owner can delete their own row
DROP POLICY IF EXISTS "Users can delete own username" ON public.usernames;
CREATE POLICY "Users can delete own username"
  ON public.usernames FOR DELETE
  USING (auth.uid() = user_id);

-- Anyone can read the username column (for public profile lookups in PR 2).
-- This is a separate policy from the owner-read policy; it exposes username + user_id
-- so the public endpoint can resolve a handle to a user_id for querying saved_artists.
DROP POLICY IF EXISTS "Anyone can read usernames" ON public.usernames;
CREATE POLICY "Anyone can read usernames"
  ON public.usernames FOR SELECT
  USING (true);

-- Backfill: set user_metadata.has_password = true for users who already have a password.
-- This ensures the settings page correctly shows the password change form for pre-existing
-- password users who signed up before the has_password flag existed.
-- Re-runnable: only updates users that don't already have the flag set.
UPDATE auth.users
SET user_metadata = jsonb_set(
  COALESCE(user_metadata, '{}'::jsonb),
  '{has_password}',
  'true'::jsonb
)
WHERE encrypted_password IS NOT NULL
  AND COALESCE(user_metadata, '{}'::jsonb)->>'has_password' IS NULL;

COMMENT ON TABLE public.usernames IS 'User-chosen public handles for sharing saved artists (UNS-31). Replaces the auth.users.username column from migration 020.';
