// API endpoint: /api/me/password
// POST — verifies current password and updates to a new one.
// Body: { current_password: string, new_password: string }
// Never logs passwords at any level.

import { withSentry } from '../lib/sentry';
import { createClient } from '@supabase/supabase-js';
import { decodeJwt } from 'jose';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

// CORS: matches the hand-rolled pattern in saved-artists.ts (permissive origin).
// The shared middleware (buildCorsHeaders) restricts to unstream.stream for
// non-API-key requests, which would break local dev and other origins using
// Bearer auth. This is existing CORS debt — see saved-artists.ts for the same pattern.
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string; email: string; accessToken: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const accessToken = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email || '', accessToken };
}

async function handleRequest(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  // Strict tier (10/min) — auth-sensitive endpoint
  const rl = await checkRateLimit(ip, 'strict', CORS_HEADERS);
  if (rl.limited) return rl.response;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const user = await authenticateRequest(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const currentPassword = body.current_password as string | undefined;
  const newPassword = body.new_password as string | undefined;

  if (!currentPassword || !newPassword) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Current password and new password are required' }) };
  }

  if (newPassword.length < 8) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'New password must be at least 8 characters' }) };
  }

  // Two-step verification, defense in depth (see docs/specs/two-factor-auth-spec.md).
  // The web client holds any account that has a verified factor behind
  // MfaChallengeGate until the session completes it, so honest traffic arrives
  // here at aal2 — but a stolen aal1 session (a password-only sign-in) must not
  // be able to rotate the password and take the account over. When the presented
  // token hasn't completed the second factor, the service role is asked whether
  // the account has one; the lookup runs only on that path, and fails closed:
  // if Supabase can't answer, the change is refused rather than guessed at.
  // decodeJwt only reads the payload — the token itself was already verified
  // against the auth server by authenticateRequest above.
  let completedSecondFactor = false;
  try {
    completedSecondFactor = decodeJwt(user.accessToken).aal === 'aal2';
  } catch {
    completedSecondFactor = false;
  }

  const serviceClient = getClient() ?? createClient(url, serviceKey);

  if (!completedSecondFactor) {
    const { data: factorsResult, error: factorsError } = await serviceClient.auth.admin.mfa.listFactors({
      userId: user.userId,
    });
    if (factorsError) {
      console.error('[me-password] Error listing MFA factors:', factorsError.message);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Could not verify two-step verification status. Please try again.' }) };
    }
    const hasVerifiedFactor = (factorsResult?.factors ?? []).some(f => f.status === 'verified');
    if (hasVerifiedFactor) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Your account uses two-step verification. Complete the second step at sign-in before changing your password.' }) };
    }
  }

  // Verify the current password by attempting a sign-in with the user's email.
  // Supabase's updateUser doesn't require the old password, so we verify it ourselves.
  const anonClient = createClient(url, anonKey);
  const { error: verifyError } = await anonClient.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });

  if (verifyError) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Current password is incorrect' }) };
  }

  // Update the password using the service role (admin API).
  // Use user_metadata (snake_case) — userMetadata is silently ignored by the admin API.
  const { error: updateError } = await serviceClient.auth.admin.updateUserById(user.userId, {
    password: newPassword,
    user_metadata: { has_password: true },
  });

  if (updateError) {
    console.error('[me-password] Error updating password:', updateError.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update password' }) };
  }

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
}

export const handler = withSentry(handleRequest);
