-- buffer_connections.refresh_claimed_at: when a request claimed a refresh it hasn't finished.
--
-- Buffer's refresh tokens are single-use, and sending a spent one revokes the whole grant. The
-- refresh is claimed before Buffer is called by bumping refresh_counter, but the counter alone only
-- stops requests that read the row before it moved: one that read it during the winner's call saw
-- the new counter and the still-stale token, claimed again, and resent the old refresh token. That
-- is why Brandon's Buffer connection kept dropping around deploys. A request that sees a recent
-- stamp waits for the winner's new token instead (usableAccessToken in api/functions/buffer-db.ts).
--
-- NULL when no refresh is under way. The table stays server-only: RLS on, no policies.

ALTER TABLE public.buffer_connections ADD COLUMN IF NOT EXISTS refresh_claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.buffer_connections.refresh_claimed_at IS
  'When a request claimed a refresh it has not finished; NULL when none is under way. Others wait for it rather than resend the single-use refresh token. A claim older than 30 seconds is treated as abandoned.';
