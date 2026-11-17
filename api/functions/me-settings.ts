// API endpoint: /api/me/settings
// GET — returns the current user's username (or null), email, and has_password flag.
// Used by the /settings page to populate the form on load.

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { endpoint, type SignedInRequest } from './http/endpoint';

// The wrapper verifies the token locally, which surfaces only the user's id and the email the
// token was issued with. This endpoint needs the user's *current* record: the email as it is
// now (it can change after the token was issued) and `user_metadata.has_password`. Reading
// either from token claims would be a guess about what Supabase puts in an access token, and
// getting it wrong shows somebody who has a password the "your account was created with a magic
// link" branch of /settings. So it asks the auth server for the record, alongside the two table
// reads rather than ahead of them.
async function handleRequest({ user }: SignedInRequest) {
  const client = getClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  try {
    // Read username + location from public.usernames (PostgREST-accessible table).
    // A pending email change (UNS-212) means the Settings page should show the
    // "confirmation sent to <new address>" notice instead of a quiet success.
    const [accountResult, usernameResult, pendingResult] = await Promise.all([
      client.auth.admin.getUserById(user.userId),
      client
        .from('usernames')
        .select('username, location')
        .eq('user_id', user.userId)
        .maybeSingle(),
      client
        .from('email_change_requests')
        .select('new_email')
        .eq('user_id', user.userId)
        // Expired rows are filtered at read: a pending link that can no longer be confirmed
        // must not keep showing as "waiting for confirmation". Nothing sweeps the table in
        // the request path any more (fix list items 3 and 8 on UNS-212), so this read is
        // where expiry is enforced on the settings side.
        .gt('expires_at', new Date().toISOString())
        .maybeSingle(),
    ]);

    // No record for a token that verified: the account is gone, or the auth server didn't
    // answer. Either way this is not somebody we can show settings to.
    const account = accountResult.data?.user;
    if (accountResult.error || !account) {
      return { status: 401, body: { error: 'Not authenticated' } };
    }

    if (usernameResult.error) {
      console.error('[me-settings] Error fetching username:', usernameResult.error.message);
      return { status: 500, body: { error: 'Failed to load settings' } };
    }
    // pendingResult.error is non-fatal when it's just the table not existing yet: the
    // email_change_requests migration lands with the merge (supabase-migrate.yml on main),
    // and pre-merge previews run branch code against the production database — which lacks
    // the table until then. A missing table must NOT take the whole Settings payload down
    // (launch blocker, 2026-10-16: 500 + hidden email on the #609 preview). Postgres 42P01 =
    // undefined_table.
    const PENDING_TABLE_MISSING =
      pendingResult.error?.code === '42P01' ||
      /relation .* does not exist|schema cache/i.test(pendingResult.error?.message || '');
    if (pendingResult.error && !PENDING_TABLE_MISSING) {
      console.error('[me-settings] Error fetching pending email change:', pendingResult.error.message);
      return { status: 500, body: { error: 'Failed to load settings' } };
    }
    if (PENDING_TABLE_MISSING) {
      console.warn('[me-settings] email_change_requests table not present yet — pendingEmailChange reported as null');
    }

    // pendingEmailChange is only ever an unexpired request, so the Settings page can show
    // "waiting for confirmation" without hedging about how stale the row might be.
    return {
      status: 200,
      body: {
        username: usernameResult.data?.username || null,
        location: usernameResult.data?.location ?? null,
        email: account.email || '',
        hasPassword: !!account.user_metadata?.has_password,
        pendingEmailChange: pendingResult.data?.new_email ?? null,
      },
    };
  } catch (error) {
    console.error('[me-settings] Error:', error);
    return { status: 500, body: { error: 'Internal server error' } };
  }
}

export const handler = withSentry(endpoint({
  cors: 'account',
  methods: ['GET'],
  auth: 'account',
  rateLimit: 'account',
  jsonBody: false,
}, handleRequest));
