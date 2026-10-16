-- UNS-212: pending email-change requests.
--
-- The Settings page lets a signed-in user propose a new email address. The change stays
-- pending here — the current email on the auth account is untouched — until the user
-- follows the confirmation link sent to the NEW address, at which point me-email-confirm
-- flips the address on the auth user and deletes the row.
--
-- Reads and writes go through the service-role client in Netlify functions (me-email.ts,
-- me-email-confirm.ts, me-settings.ts), so RLS is enabled with no policies: anon and
-- authenticated get nothing at /rest/v1, and the service role bypasses RLS. Same shape as
-- bandcamp_slug_probes (20260726120000). This matters more than usual here: the rows hold
-- pending email addresses and single-use secrets.
--
-- The confirmation token is not stored in plaintext. token_hash holds SHA-256(token_hex);
-- the lookup is by hash, so a database leak can't be replayed as a confirmation link.
-- (Same defense-in-depth reasoning as the hashed API keys in api-keys.ts.)

create table if not exists public.email_change_requests (
  -- One pending change per user: a new request upserts over any earlier one, and the
  -- confirm endpoint matches on user_id first, token second.
  user_id     uuid primary key references auth.users(id) on delete cascade,

  -- The proposed address, stored lowercased. NOT unique across rows by design: two
  -- different users may each have a pending change to the same address. Ownership of the
  -- address is decided by whoever confirms first (see me-email-confirm.ts).
  new_email   text not null,

  -- SHA-256 of the emailed token (hex). The plaintext token exists only in the email link.
  token_hash  text not null,

  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours'
);

-- One row per user makes every lookup by user_id exact. The expiry scan that deletes
-- stale rows in me-email.ts also uses expires_at.
create index if not exists email_change_requests_expires_at_idx
  on public.email_change_requests (expires_at);

alter table public.email_change_requests enable row level security;

comment on table public.email_change_requests is
  'Pending email changes (UNS-212). Service-role only: RLS enabled, no policies. token_hash is SHA-256 of the emailed confirmation token; plaintext never stored.';