/**
 * Server-side Resend client for transactional emails (claim approvals, and future
 * account-lifecycle notifications). Mirrors the direct-fetch pattern used for Buttondown in
 * api/functions/newsletter-subscribe.ts rather than pulling in the Resend SDK.
 *
 * Requires RESEND_API_KEY in the environment. Also requires unstream.stream (or the sending
 * subdomain used in FROM_ADDRESS) to be a verified domain in the Resend dashboard — Resend
 * rejects sends from unverified domains, so this can't be tested end-to-end until that's done.
 */

import { Sentry } from './sentry';

const RESEND_SEND_URL = 'https://api.resend.com/emails';
const UPSTREAM_TIMEOUT_MS = 8000;

const FROM_ADDRESS = 'Unstream <notifications@unstream.stream>';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function sendTransactionalEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // A missing key must never look like a silently-skipped send — that's how a broken claim
    // notification goes unnoticed for a month.
    Sentry.captureMessage('sendTransactionalEmail: RESEND_API_KEY is not set', 'error');
    return { ok: false, error: 'RESEND_API_KEY not set' };
  }

  let response: Response;
  try {
    response = await fetch(RESEND_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeout or network failure — we don't know whether Resend received it, so say so
    // rather than guessing in either direction.
    Sentry.captureException(error, { extra: { context: 'sendTransactionalEmail.fetch', to: params.to } });
    return { ok: false, error: error instanceof Error ? error.message : 'network error' };
  }

  const raw = await response.text();
  let payload: { id?: string; message?: string } = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Non-JSON body — handled by the status check below.
  }

  if (response.ok) {
    return { ok: true, messageId: payload.id };
  }

  Sentry.captureMessage(
    `sendTransactionalEmail: Resend returned ${response.status} (${payload.message || 'no message'})`,
    'error',
  );
  return { ok: false, error: payload.message || `HTTP ${response.status}` };
}
