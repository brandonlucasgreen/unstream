// API endpoint: /api/me/password
// POST — verifies current password and updates to a new one.
// Body: { current_password: string, new_password: string }
// Never logs passwords at any level.

import { withSentry } from '../lib/sentry';
import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

async function handleRequest({ user, body }: SignedInRequest): Promise<EndpointResult> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  const currentPassword = body.current_password as string | undefined;
  const newPassword = body.new_password as string | undefined;

  if (!currentPassword || !newPassword) {
    return { status: 400, body: { error: 'Current password and new password are required' } };
  }

  if (newPassword.length < 8) {
    return { status: 400, body: { error: 'New password must be at least 8 characters' } };
  }

  const serviceClient = getClient() ?? createClient(url, serviceKey);

  // Verify the current password by attempting a sign-in with the user's email.
  // Supabase's updateUser doesn't require the old password, so we verify it ourselves.
  const anonClient = createClient(url, anonKey);
  const { error: verifyError } = await anonClient.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });

  if (verifyError) {
    return { status: 400, body: { error: 'Current password is incorrect' } };
  }

  // Update the password using the service role (admin API).
  // Use user_metadata (snake_case) — userMetadata is silently ignored by the admin API.
  const { error: updateError } = await serviceClient.auth.admin.updateUserById(user.userId, {
    password: newPassword,
    user_metadata: { has_password: true },
  });

  if (updateError) {
    console.error('[me-password] Error updating password:', updateError.message);
    return { status: 500, body: { error: 'Failed to update password' } };
  }

  return { status: 200, body: { success: true } };
}

export const handler = withSentry(endpoint({
  cors: 'account',
  methods: ['POST'],
  // The token is checked against Supabase on every request, and that check also refuses a session
  // that still owes its two-step verification (see docs/specs/two-factor-auth-spec.md), so one
  // never gets here. The web client holds such a session behind MfaChallengeGate, but that gate is
  // only UI: a stolen password-only session must not be able to rotate the password and take the
  // account over.
  auth: 'bearer',
  // Strict tier (10/min) — auth-sensitive endpoint
  rateLimit: 'strict',
  jsonBody: true,
}, handleRequest));
