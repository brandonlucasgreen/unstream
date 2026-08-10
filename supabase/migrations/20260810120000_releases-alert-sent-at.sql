-- Migration: releases.alert_sent_at
--
-- Which releases the new-release alert email has already accounted for, so a second email can
-- never repeat a release the recipient has already been told about.
--
-- The alert used to work this out from counts: release_catalog_state.releases_found before and
-- after a catalog run, with the difference taken as "the newest N rows by created_at". Counts
-- can't express what actually happened. A run that removes one release and adds two leaves the
-- total up by one and re-announces a release that was already sent; a total that dips and
-- recovers re-announces the same rows again. Nothing about a count says *which* records are new.
--
-- This column says it directly. api/functions/notifications.ts claims the unalerted rows for an
-- artist with a single UPDATE ... RETURNING (atomic, so two concurrent catalog runs can't both
-- claim the same release), emails exactly what it claimed, and sends nothing at all when the
-- claim comes back empty. A release is therefore announced at most once, ever.
--
-- NULL means "not yet accounted for", which is why new rows must arrive NULL — hence the
-- default is added and then immediately dropped below.

-- The default backfills every row that already exists: an artist catalogued before this
-- deployed has, by definition, already been through the old alerting path, and without the
-- backfill the first run after deploy would claim entire discographies and mail them out as
-- new. Dropping the default afterwards leaves future inserts NULL, so only genuinely new
-- releases are ever candidates. Both statements are idempotent, in that order.
ALTER TABLE releases ADD COLUMN IF NOT EXISTS alert_sent_at timestamptz DEFAULT now();
ALTER TABLE releases ALTER COLUMN alert_sent_at DROP DEFAULT;

-- Partial index: the claim query only ever asks for one artist's *unalerted* rows, which is a
-- vanishing fraction of the table (every row is alerted within one catalog run of being
-- inserted), so indexing only those keeps it a tiny lookup instead of a scan of the artist's
-- whole discography.
CREATE INDEX IF NOT EXISTS idx_releases_unalerted
  ON releases (artist_id)
  WHERE alert_sent_at IS NULL;

COMMENT ON COLUMN releases.alert_sent_at IS
  'When the new-release alert email accounted for this release. NULL means not yet accounted for; set once and never cleared, which is what stops a release being announced twice. Ingest must never write it — see api/functions/notifications.ts.';
