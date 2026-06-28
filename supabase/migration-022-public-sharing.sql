-- Migration 022: Public sharing of saved artists list (UNS-31 PR 2)
-- Adds saved_artists_public column to public.usernames.
-- Depends on migration 021 (public.usernames table).
--
-- Architecture note: user_public_ids table was originally introduced here as a
-- separate public-handle table, but both read paths (u-handle.ts edge function
-- and public-saved-artists.ts API) resolve via public.usernames filtered on
-- username + saved_artists_public. The user_public_ids table was never read by
-- either renderer, making it dead weight. It was dropped in round-2 review
-- (PR #295) in favor of keeping public.usernames as the single source of truth.
-- The reserved-handle guard is enforced server-side by isReservedHandle() in
-- user-sharing.ts (the only path that flips saved_artists_public to true),
-- and migration 021's CHECK constraints on usernames.username.
--
-- Round-2 review #11 also removed the anon SELECT policy from migration 021's
-- usernames table. RLS is row-level, not column-level, so the USING (true) policy
-- leaked user_id (auth UUID) + saved_artists_public to anyone with the anon key.
-- All read paths use the service-role client (bypasses RLS), so the policy had no
-- consumer. Only owner-scoped policies remain on usernames.

-- Add saved_artists_public flag to the existing usernames table.
-- Default false — users must explicitly opt in to sharing.
ALTER TABLE public.usernames
  ADD COLUMN IF NOT EXISTS saved_artists_public BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.usernames.saved_artists_public IS 'Whether the user has enabled public sharing of their saved artists list (UNS-31 PR 2).';