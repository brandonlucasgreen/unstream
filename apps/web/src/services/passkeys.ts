// Passkey sign-in on Supabase Auth: a passkey is a way to *sign in* (in place of
// a password or a sign-in link), not a second step. Every call here goes from
// the browser straight to Supabase — no Unstream API function is involved.
// Managed in the "Passkeys" section of /settings; used on /login.
//
// A passkey sign-in yields an aal1 session, like a password does, so an account
// with an authenticator app still meets MfaChallengeGate afterwards. That is
// what keeps a passkey added from a stolen-password session from getting past
// the second step. See docs/specs/passkey-sign-in-spec.md.
//
// Supabase marks this API experimental, which is why @supabase/supabase-js is
// pinned to an exact version in package.json: upgrade it on purpose, and re-run
// the passkey flows on unstream.stream when you do.

import type { AuthError } from '@supabase/supabase-js';
import * as Sentry from '@sentry/react';
import { getSupabaseClient } from './auth';

export interface Passkey {
  id: string;
  /** Supabase names it after where it's stored ("iCloud Keychain", "1Password"). */
  friendlyName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Whether this browser can run a WebAuthn ceremony at all. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && window.isSecureContext;
}

/**
 * Whether the browser can offer passkeys in the email field's autofill
 * (WebAuthn "conditional UI"). Older browsers lack the check entirely.
 */
export async function passkeyAutofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const check = window.PublicKeyCredential.isConditionalMediationAvailable;
  if (typeof check !== 'function') return false;
  try {
    return await check.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}

type PasskeyError = Error & { code?: string };

/**
 * Whether a failure is the person backing out, or the page cancelling a
 * pending prompt — no error text, no Sentry report. Browsers report a
 * dismissed prompt as NotAllowedError; auth-js reports a ceremony it aborted
 * (one superseded by a newer call) as ERROR_CEREMONY_ABORTED.
 */
function isCancelled(error: PasskeyError): boolean {
  return error.name === 'NotAllowedError'
    || error.name === 'AbortError'
    || error.code === 'ERROR_CEREMONY_ABORTED';
}

/** Failures that are the person's situation, not a fault worth reporting. */
const EXPECTED_CODES = new Set([
  'webauthn_credential_not_found',
  'webauthn_credential_exists',
  'webauthn_challenge_expired',
  'too_many_passkeys',
]);

function reportPasskeyFailure(operation: string, error: PasskeyError): void {
  if (error.code && EXPECTED_CODES.has(error.code)) return;
  Sentry.captureMessage(`Passkey failed: ${operation}`, {
    level: 'warning',
    tags: { context: 'auth.service', passkey_operation: operation, passkey_error_code: error.code ?? 'none' },
    extra: { errorMessage: error.message, errorName: error.name },
  });
}

/** A failure as the person should read it. */
export function friendlyPasskeyError(error: PasskeyError): string {
  switch (error.code) {
    case 'webauthn_credential_not_found':
      return "That passkey isn't registered with Unstream anymore. Sign in another way, then add it again in Settings.";
    case 'webauthn_credential_exists':
      return 'This passkey is already on your account.';
    case 'webauthn_challenge_expired':
      return 'That took a little too long. Try your passkey again.';
    case 'too_many_passkeys':
      return 'Your account has as many passkeys as it can hold. Remove one in Settings to add another.';
    case 'passkey_disabled':
      return "Passkey sign-in isn't available right now. Use your password or a sign-in link.";
    default:
      return error.message || 'The passkey prompt failed. Try again.';
  }
}

export type PasskeySignInResult =
  | { status: 'signed-in' }
  | { status: 'cancelled' }
  | { status: 'expired' }
  | { status: 'failed'; error: string };

/**
 * Sign in with a passkey. On success the client emits SIGNED_IN, so
 * AuthContext picks up the session and /login moves on by itself.
 *
 * `autofill` asks the browser to offer passkeys in the email field's
 * suggestions instead of opening a picker; that prompt can sit pending until
 * the page aborts `signal`. Its challenge expires after five minutes, so a
 * passkey picked later than that comes back `expired`, and the caller starts a
 * fresh one.
 */
export async function signInWithPasskey(
  { autofill = false, signal }: { autofill?: boolean; signal?: AbortSignal } = {},
): Promise<PasskeySignInResult> {
  const supabase = getSupabaseClient();
  if (!supabase) return { status: 'failed', error: 'Auth not configured' };

  const { error } = await supabase.auth.signInWithPasskey({
    options: { signal, ...(autofill ? { mediation: 'conditional' as const } : {}) },
  });
  if (!error) return { status: 'signed-in' };
  if (isCancelled(error) || signal?.aborted) return { status: 'cancelled' };
  const code = (error as PasskeyError).code;
  if (code === 'webauthn_challenge_expired') return { status: 'expired' };
  // The autofill prompt starts by itself on every visit to /login, before
  // anyone has asked for a passkey. Only a failure after they picked one (the
  // webauthn_* verification codes) is theirs to read; anything earlier stays
  // quiet on the page. A switched-off feature isn't reported either: the
  // button reports it when someone actually presses it.
  if (autofill && !code?.startsWith('webauthn_')) {
    if (code !== 'passkey_disabled') reportPasskeyFailure('signInAutofill', error);
    return { status: 'cancelled' };
  }
  reportPasskeyFailure(autofill ? 'signInAutofill' : 'signIn', error);
  return { status: 'failed', error: friendlyPasskeyError(error) };
}

export async function listPasskeys(): Promise<{ passkeys: Passkey[]; error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { passkeys: [], error: 'Auth not configured' };

  const { data, error } = await supabase.auth.passkey.list();
  if (error) {
    reportPasskeyFailure('list', error);
    return { passkeys: [], error: error.message };
  }
  return {
    passkeys: (data ?? []).map(item => ({
      id: item.id,
      friendlyName: item.friendly_name ?? null,
      createdAt: item.created_at,
      lastUsedAt: item.last_used_at ?? null,
    })),
    error: null,
  };
}

/**
 * Add a passkey to the signed-in account. A dismissed prompt returns no error,
 * since there's nothing to tell the person.
 */
export async function registerPasskey(): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.registerPasskey();
  if (!error) return { error: null };
  if (isCancelled(error)) return { error: null };
  reportPasskeyFailure('register', error);
  return { error: friendlyPasskeyError(error) };
}

export async function deletePasskey(passkeyId: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.passkey.delete({ passkeyId });
  if (error) {
    reportPasskeyFailure('delete', error as AuthError);
    return { error: error.message };
  }
  return { error: null };
}
