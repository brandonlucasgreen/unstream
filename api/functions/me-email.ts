// API endpoint: /api/me/email
// POST — { new_email: string }: propose an email change. Stores a pending request and
//        emails a confirmation link to the NEW address. The current email on the auth
//        account is untouched until the link is followed (me-email-confirm).
// DELETE — cancel a pending change (used by the Settings page's "cancel" link).
//
// The confirmation email is the only path that applies the change. Until then the user
// keeps signing in with the old address. See supabase/migrations/20261016130000 for the
// table and why RLS is service-role only.

import { withSentry } from '../lib/sentry';
import { randomBytes, createHash } from 'crypto';
import { getClient } from './db';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';
import { sendTransactionalEmail } from '../lib/resend';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
};

// Same shape as LoginPage's EMAIL_PATTERN — string-only early validation so the user gets
// a specific message instead of a raw database or Supabase error.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SITE = 'https://unstream.stream';

// Confirmations live one day. Long enough to click from another device; short enough that
// a stale link can't sit in a mailbox forever.
const CONFIRMATION_TTL_HOURS = 24;

export function pendingConfirmLink(token: string): string {
  return `${SITE}/settings?confirm_email=${token}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

async function handleRequest(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // One verification, not two: resolveAccountRequest checks the token while deriving the
  // rate-limit bucket (see me-feed-token.ts for the established pattern).
  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;

  if (!user) return json(401, { error: 'Not signed in' });

  const client = getClient();
  if (!client) {
    return json(500, { error: 'Database not configured' });
  }

  if (event.httpMethod === 'DELETE') {
    const { error } = await client
      .from('email_change_requests')
      .delete()
      .eq('user_id', user.userId);
    if (error) {
      console.error('[me-email] Error deleting pending change:', error.message);
      return json(500, { error: 'Could not cancel the pending change' });
    }
    return json(200, { cancelled: true });
  }

  if (event.httpMethod !== 'POST') {
    return json(404, { error: 'Not found' });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const newEmail = typeof body.new_email === 'string' ? body.new_email.trim().toLowerCase() : '';
  if (!EMAIL_PATTERN.test(newEmail)) {
    return json(400, { error: "That email address doesn't look right. Check it and try again." });
  }

  if (newEmail === user.email?.toLowerCase()) {
    return json(400, { error: 'That is already your email address.' });
  }

  // The token exists in three places and no more: this string, the confirmation link in
  // the email, and nowhere on disk — the table stores only its SHA-256 hash.
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_HOURS * 60 * 60 * 1000).toISOString();

  // Upsert by user_id: a second request replaces the first (and its token), which is both
  // what the user expects and what caps the table at one row per user.
  const { error: insertError } = await client
    .from('email_change_requests')
    .upsert(
      { user_id: user.userId, new_email: newEmail, token_hash: tokenHash, expires_at: expiresAt },
      { onConflict: 'user_id' },
    );

  if (insertError) {
    console.error('[me-email] Error storing pending change:', insertError.message);
    return json(500, { error: 'Could not start the email change' });
  }

  // Opportunistic cleanup: drop other users' expired rows so the table self-treats. A miss
  // here (Redis-style) is fine — expiry is also enforced when confirming.
  await client.from('email_change_requests').delete().lt('expires_at', new Date().toISOString());

  const confirmUrl = pendingConfirmLink(token);
  const emailResult = await sendTransactionalEmail({
    to: newEmail,
    subject: 'Confirm your new email for Unstream',
    html:
      `<p>Hi there,</p>` +
      `<p>Someone — hopefully you — asked to change the email address on an Unstream account to this one. ` +
      `<strong>The account still uses its old address until you click the button below.</strong></p>` +
      `<p><a href="${confirmUrl}">Confirm this email address</a></p>` +
      `<p>If you didn't request this, you can safely ignore this email — nothing changes, ` +
      `and the request expires in ${CONFIRMATION_TTL_HOURS} hours.</p>` +
      `<p>Unstream · <a href="${SITE}">unstream.stream</a></p>`,
    text:
      `Someone — hopefully you — asked to change the email address on an Unstream account to this one. ` +
      `The account still uses its old address until you confirm.\n\n` +
      `Confirm this email address: ${confirmUrl}\n\n` +
      `If you didn't request this, ignore this email — nothing changes, and the request expires in ` +
      `${CONFIRMATION_TTL_HOURS} hours.\n\nUnstream · ${SITE}`,
  });

  // The pending row legitimately exists even when Resend fails (rate-limited key, verified-
  // domain hiccup), but the user would wait forever for an email that is never coming, so
  // roll the row back. The loud report in sendTransactionalEmail (Sentry) still fires.
  if (!emailResult.ok) {
    await client.from('email_change_requests').delete().eq('user_id', user.userId);
    return json(502, { error: 'The confirmation email could not be sent. Please try again in a moment.' });
  }

  // Never echo whether the new address is already registered anywhere — this endpoint is
  // reachable by any signed-in user, and a "that address is taken" answer would turn it
  // into an enumeration oracle. Confirmation handles collisions instead.
  return json(202, { pending: true, new_email: newEmail });
}

export const handler = withSentry(handleRequest);