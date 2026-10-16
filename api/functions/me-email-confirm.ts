// API endpoint: /api/me/email/confirm
// POST — { token: string }: confirm a pending email change. Called by the Settings page
// when it loads with ?confirm_email=<token> (the link in the confirmation email) and the
// visitor is signed in.
//
// On success the auth account's email is swapped to the pending address, the pending row
// is deleted, and the response says so — the client refreshes its own session so the JWT
// picks up the new email claim. The SPA redirects to /settings, which shows the success
// banner. Failures return a message the banner can show; the pending row is only deleted
// when no retry could still succeed.

import { withSentry } from '../lib/sentry';
import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'crypto';
import { getClient } from './db';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';
import { buildAccountCorsHeaders } from './account-cors';

// Tokens are minted in me-email as randomBytes(32).toString('hex') — always 64 hex chars.
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

async function handleRequest(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  // Per-request, allowlisted origin — never '*' on an endpoint that takes a Bearer token
  // (fix list item 1 on UNS-212).
  const corsHeaders = buildAccountCorsHeaders(
    event.headers['origin'] || event.headers['Origin'],
    'POST, OPTIONS',
  );

  const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { ...corsHeaders, 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Any signed-in visitor can carry a token in from a link; the token itself is the
  // authorization, and the session says which account the change applies to. Strict-tier
  // rate limiting caps guessed-token floods.
  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'strict', corsHeaders);
  if (rl.limited) return rl.response;

  // POST is the whole surface; a wrong method is a 405, not a missing resource (repo
  // convention — see artist-releases.ts). The 404 further down stays: that one means "no
  // pending change for this account", which is a real not-found.
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, Allow: 'POST, OPTIONS' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  if (!user) return json(401, { error: 'Sign in to confirm this email change.' });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : '';
  if (!TOKEN_PATTERN.test(token)) {
    return json(400, { error: 'This confirmation link is incomplete or malformed. Start a new email change from Settings.' });
  }

  const client = getClient();
  if (!client) {
    return json(500, { error: 'Database not configured' });
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    return json(500, { error: 'Database not configured' });
  }

  const { data: pending, error: pendingError } = await client
    .from('email_change_requests')
    .select('user_id, new_email, token_hash, expires_at')
    .eq('user_id', user.userId)
    .maybeSingle();

  if (pendingError) {
    console.error('[me-email-confirm] Error loading pending change:', pendingError.message);
    return json(500, { error: 'Could not look up the pending change' });
  }

  // A missing row means expired-and-swept, already confirmed, or a link for a different
  // account than the one signed in here. One message for all three — no oracle either way.
  if (!pending) {
    return json(404, {
      error: 'No pending email change for this account. The link may have expired or already been used, or it belongs to a different account. Start a new change from Settings.',
    });
  }

  // Compare SHA-256 digests, timing-safe. me-email stored sha256(token); hash this token
  // the same way and compare bytes. A mismatch must not delete the row — the real email
  // may still be in transit, or a newer request replaced this link's row.
  const candidate = createHash('sha256').update(token).digest();
  const stored = Buffer.from(pending.token_hash, 'hex');
  const tokenMatches = stored.length === candidate.length && timingSafeEqual(stored, candidate);

  if (!tokenMatches) {
    return json(403, {
      error: 'This confirmation link is not valid. Open the link from the newest confirmation email, or start a new email change from Settings.',
    });
  }

  if (new Date(pending.expires_at).getTime() <= Date.now()) {
    // Right token, stale link: no retry can succeed, so sweep the row.
    await client.from('email_change_requests').delete().eq('user_id', user.userId);
    return json(410, { error: 'This confirmation link has expired. Start a new email change from Settings.' });
  }

  // --- Confirmed. Apply the change. ---

  // Apply via the admin API with the service client (same pattern as me-password). If the
  // address is already on another account, Supabase rejects the update; that surfaces as a
  // 409 and the dead.pending row is cleaned up — the change can never go through.
  const serviceClient = createClient(url, serviceKey);
  const { error: updateError } = await serviceClient.auth.admin.updateUserById(user.userId, {
    email: pending.new_email,
    // The user just proved the new address is reachable by clicking the link, so marking
    // it confirmed is the honest state — and it stops Supabase from sending its own second
    // "confirm your email" message for an address we already know they receive.
    email_confirm: true,
  });

  if (updateError) {
    const alreadyRegistered = /already[\s\S]*(registered|in use)|already exists|\bexists\b/i.test(updateError.message);
    if (alreadyRegistered) {
      // Someone else holds the address now (e.g. they confirmed their own change to it
      // first). The pending row can never succeed; delete it and say so plainly.
      await client.from('email_change_requests').delete().eq('user_id', user.userId);
      return json(409, {
        error: 'That email address is already on another Unstream account. The pending change was cancelled — start a new one from Settings with a different address.',
      });
    }
    console.error('[me-email-confirm] Error applying email change:', updateError.message);
    return json(500, { error: 'Could not apply the email change. Try the link again in a moment.' });
  }

  // One-shot: burn the token. Anything failing past this point has already changed the
  // email; a retried link will just report "no pending change".
  await client.from('email_change_requests').delete().eq('user_id', user.userId);

  // The access token the client holds still carries the old email in its claims until it
  // expires (~1h). The client refreshes its session against the auth server after this
  // response, which re-issues a token with the new address — no re-login needed.
  return json(200, { confirmed: true, email: pending.new_email });
}

export const handler = withSentry(handleRequest);