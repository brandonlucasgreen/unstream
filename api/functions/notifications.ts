// Transactional email notifications for account-lifecycle events (claim approved/rejected,
// and future triggers such as release alerts). Wraps sendTransactionalEmail with an
// idempotency guard so a retried request or a second admin click can't send the same
// notification twice.
//
// email_log is the source of truth for "did we already send this": the insert's unique
// constraint on (notification_type, reference_id) is what makes the guard atomic under
// concurrent calls, not an application-level check-then-send race.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTransactionalEmail } from '../lib/resend';
import { Sentry } from '../lib/sentry';

interface NotifyOnceParams {
  client: SupabaseClient;
  notificationType: string;
  referenceId: string;
  recipientEmail: string;
  subject: string;
  html: string;
  text: string;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Sends a transactional email at most once per (notificationType, referenceId). Failures —
 * duplicate send, missing API key, Resend error — are logged to Sentry and swallowed; a
 * notification email is never allowed to fail the request that triggered it.
 */
export async function sendNotificationOnce(params: NotifyOnceParams): Promise<void> {
  const { client, notificationType, referenceId, recipientEmail, subject, html, text } = params;

  const { data: logRow, error: insertError } = await client
    .from('email_log')
    .insert({
      notification_type: notificationType,
      reference_id: referenceId,
      recipient_email: recipientEmail,
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === UNIQUE_VIOLATION) {
      // Already sent (or in flight) for this reference — the guard working, not a failure.
      return;
    }
    Sentry.captureException(insertError, {
      extra: { context: 'sendNotificationOnce.insert', notificationType, referenceId },
    });
    return;
  }

  const result = await sendTransactionalEmail({ to: recipientEmail, subject, html, text });

  const { error: updateError } = await client
    .from('email_log')
    .update({
      status: result.ok ? 'sent' : 'failed',
      resend_message_id: result.messageId || null,
      error: result.error || null,
    })
    .eq('id', logRow.id);

  if (updateError) {
    Sentry.captureException(updateError, {
      extra: { context: 'sendNotificationOnce.update', notificationType, referenceId },
    });
  }

  if (!result.ok) {
    Sentry.captureMessage(`sendNotificationOnce: failed to send ${notificationType}`, {
      level: 'error',
      extra: { referenceId, error: result.error },
    });
  }
}
