-- Migration: notification_preferences
--
-- Per-user opt-out toggles for the saved-artist and analytics-recap emails sent via Resend
-- (new_release, new_platform_link, weekly_analytics_recap — see api/functions/notifications.ts
-- and api/functions/weekly-analytics-recap.ts). Claim-lifecycle emails (approved/rejected) are
-- not covered here — those are a direct reply to an action the user just took, not an ongoing
-- subscription.
--
-- Defaults to enabled: saving an artist is treated as consent to hear about it, and claiming
-- and verifying a profile is treated as consent to see your own weekly stats. Rows are created
-- lazily on first toggle (see me-notifications.ts), not at signup, so a missing row is the
-- common case and must read as "all enabled" — every notification-sending call site treats a
-- missing row the same as a row with all three columns true.

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  new_release boolean NOT NULL DEFAULT true,
  new_platform_link boolean NOT NULL DEFAULT true,
  weekly_analytics_recap boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_notification_preferences_updated_at ON notification_preferences;
CREATE TRIGGER trg_notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION set_releases_updated_at();

-- User-editable (unlike email_log): same auth.uid() = user_id pattern as saved_artists. Server
-- code paths use the service-role client and bypass this, same as user-sharing.ts /
-- me-location.ts — RLS here is a backstop against any future direct client-side access.
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notification preferences"
  ON notification_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notification preferences"
  ON notification_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notification preferences"
  ON notification_preferences FOR UPDATE
  USING (auth.uid() = user_id);

COMMENT ON TABLE notification_preferences IS
  'Per-user opt-out toggles for saved-artist and analytics-recap emails. A missing row means all three are enabled — see table comment.';
