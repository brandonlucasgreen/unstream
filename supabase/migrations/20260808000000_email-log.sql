-- Migration: email_log
--
-- Idempotency guard and audit trail for transactional emails sent via Resend (claim
-- approved/rejected notifications, and future triggers like release alerts). The unique
-- index on (notification_type, reference_id) is the guard: a retried request or a second
-- admin click on the same verification request can't send the same notification twice,
-- because the second insert hits the constraint and is treated as "already handled" rather
-- than as an error.
--
-- reference_id is deliberately not a foreign key — it points at different tables depending
-- on notification_type (artists.id for an auto-verified claim, verification_requests.id for
-- a manual review decision), so there's no single table it could reference.

CREATE TABLE IF NOT EXISTS email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type text NOT NULL,
  reference_id uuid NOT NULL,
  recipient_email text NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  resend_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The idempotency guard itself: at most one row ever exists per (notification_type,
-- reference_id), regardless of status. There's no retry path today, so a 'failed' row
-- staying failed is correct — a future retry mechanism would need to delete the row first,
-- which is a deliberate, visible action rather than an accidental double-send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_log_dedup
  ON email_log (notification_type, reference_id);

CREATE INDEX IF NOT EXISTS idx_email_log_created_at
  ON email_log (created_at DESC);

DROP TRIGGER IF EXISTS trg_email_log_updated_at ON email_log;
CREATE TRIGGER trg_email_log_updated_at
  BEFORE UPDATE ON email_log
  FOR EACH ROW
  EXECUTE FUNCTION set_releases_updated_at();

-- Server-only: this is internal send bookkeeping, nothing a client should ever read or
-- write. RLS on with no policies means the service-role client (which bypasses RLS) is the
-- only reader or writer — same pattern as release_catalog_state and bandcamp_slug_probes.
ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE email_log IS
  'Idempotency guard and audit trail for transactional emails sent via Resend. Server-only; no RLS policies by design.';
COMMENT ON COLUMN email_log.reference_id IS
  'Points at different tables depending on notification_type — not a foreign key.';
