-- Migration: restate what releases.alert_sent_at means
--
-- Comment only — no schema change. 20260810120000 introduced the column on the assumption that
-- every release would be accounted for within one catalog run of being inserted, which is what
-- the partial index on the unalerted rows was sized for. That is no longer true, and the column
-- comment (and the index's expected size) should say so rather than quietly drift.
--
-- The alert now only announces releases that came out in the last week or are still to come, so
-- api/functions/notifications.ts claims the rows whose age it can judge and leaves undated ones
-- pending. "We don't know when this came out" is not "this is old" — the detail pass is budgeted,
-- so a release can arrive dateless in one run and dated in the next — and writing alert_sent_at
-- on the strength of a missing date would cache that uncertainty as a permanent no.
--
-- The practical consequence: rows can now stay NULL indefinitely, so idx_releases_unalerted holds
-- a standing population of undated releases rather than briefly-pending ones. It is still a small
-- per-artist lookup and needs no change; it is simply no longer near-empty.

COMMENT ON COLUMN releases.alert_sent_at IS
  'When the new-release alert accounted for this release, whether or not it was worth emailing about. NULL means undecided — either not yet catalogued into an alert, or undated, since an unknown release date is not evidence a release is old. Set once and never cleared, which is what stops a release being announced twice. Ingest must never write it — see api/functions/notifications.ts.';
