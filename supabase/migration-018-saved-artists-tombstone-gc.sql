-- Migration 018: Scheduled GC for saved_artists tombstones (UNS-128)
--
-- Migration 017 added soft-delete (deleted, deleted_at columns) for cross-client
-- sync tombstones. Without GC, these accumulate forever — every artist that any
-- user ever unsaved would stay in the table. This migration adds a daily 3am UTC
-- sweep that hard-deletes tombstones older than 30 days.
--
-- The 30-day window is generous: sync clients reconcile via tombstones on
-- the next pull, and a 5-min force-pull acts as a backstop for long sessions.
-- 30 days of buffer easily covers offline clients, slow networks, and any
-- scheduling jitter.
--
-- Required: pg_cron extension must be enabled in the Supabase dashboard
-- before this migration runs. UNS-132 tracks that step.

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION gc_saved_artists_tombstones()
RETURNS void AS $$
BEGIN
  DELETE FROM saved_artists
  WHERE deleted = true
    AND deleted_at < now() - interval '30 days';
END;
$$ LANGUAGE plpgsql;

-- Idempotent: unschedule first so re-running the migration doesn't error.
-- cron.job is the pg_cron catalog table.
SELECT cron.unschedule('gc-saved_artists_tombstones')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'gc-saved_artists_tombstones'
  );

-- Schedule: 3am UTC daily. Low-traffic window; runs a single DELETE.
SELECT cron.schedule(
  'gc-saved_artists_tombstones',
  '0 3 * * *',
  $$SELECT gc_saved_artists_tombstones();$$
);