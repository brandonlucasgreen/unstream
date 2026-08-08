-- Migration: expire app_events session hashes after 90 days
--
-- app_events has never had any retention. Every product event since the table shipped is still
-- there, and each row carries session_hash — a keyed HMAC of (ip + user_agent + date). It can't
-- be reversed and it rotates daily, which is why the privacy policy files it as pseudonymous
-- rather than anonymous. But an identifier kept forever is an identifier kept longer than it's
-- useful: session_hash exists to deduplicate visits *within a single day*, so after 90 days it
-- has no analytical value left, only liability.
--
-- Nulling the column rather than deleting the row is the point. Every count the admin dashboard
-- draws — events per type, per app, over time — is unaffected, because none of them group by
-- session. The history stays complete and stops being personal data.
--
-- Deleting rows outright was the alternative and it costs year-over-year trends for no gain.
--
-- Follows the pg_cron pattern established by migration 018 (saved_artists tombstone GC).

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION expire_app_event_session_hashes()
RETURNS void AS $$
BEGIN
  -- `IS NOT NULL` keeps this cheap: once a row has been scrubbed it is never rewritten, so
  -- each nightly run only touches the day that just aged past the window.
  UPDATE app_events
  SET session_hash = NULL
  WHERE session_hash IS NOT NULL
    AND created_at < now() - interval '90 days';
END;
$$ LANGUAGE plpgsql;

-- Partial index so the sweep finds the day's worth of expiring rows without scanning the whole
-- table. It only covers unscrubbed rows, so it shrinks as the backlog is cleared.
CREATE INDEX IF NOT EXISTS idx_app_events_unscrubbed
  ON app_events (created_at)
  WHERE session_hash IS NOT NULL;

-- Idempotent: unschedule first so re-running the migration doesn't error.
SELECT cron.unschedule('expire-app_event_session_hashes')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'expire-app_event_session_hashes'
  );

-- 3:20am UTC daily — a low-traffic window, offset from the 3am tombstone GC so the two single
-- statement jobs don't land together.
SELECT cron.schedule(
  'expire-app_event_session_hashes',
  '20 3 * * *',
  $$SELECT expire_app_event_session_hashes();$$
);

-- The first run clears the whole backlog accumulated since the table shipped, which is the
-- intent — everything older than 90 days should never have kept its hash this long.

COMMENT ON COLUMN app_events.session_hash IS
  'Keyed HMAC of (ip + user_agent + date) for same-day deduplication. Never a raw IP. Nulled after 90 days by expire_app_event_session_hashes(), after which the row is fully anonymous.';
