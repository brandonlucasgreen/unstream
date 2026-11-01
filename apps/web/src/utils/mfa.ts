import type { Session, User } from '@supabase/supabase-js';

/**
 * Pure two-step-verification helpers over the Supabase session. Supabase puts
 * two things where the client can read them without a network call: the `aal`
 * claim on the access token (which factors this *session* has completed) and
 * `user.factors` (which factors the *account* has). `getAuthenticatorAssuranceLevel`
 * does this same decoding inside auth-js; we do it ourselves so the sign-in gate
 * is one synchronous, unit-testable function instead of another await.
 */

/**
 * The `aal` claim of a Supabase access token, decoded — `aal2` when the session
 * has completed a second factor, `aal1` when it hasn't, null when the token
 * doesn't say (which, for a Supabase-issued token, is never).
 *
 * No signature verification: the token is Supabase's, and the server re-checks
 * anything that matters with its own verification.
 */
export function decodeAalClaim(accessToken: string): string | null {
  const payloadPart = accessToken.split('.')[1];
  if (!payloadPart) return null;
  try {
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { aal?: unknown };
    return typeof payload.aal === 'string' ? payload.aal : null;
  } catch {
    return null;
  }
}

export function hasVerifiedSecondFactor(user: User | null): boolean {
  return (user?.factors ?? []).some(f => f.status === 'verified');
}

/**
 * Whether the app should be holding this session behind the two-step challenge.
 *
 * True only when the account has a verified factor AND this session hasn't
 * completed it. An unreadable token counts as needing the challenge: the gate
 * must fail closed — wrongly asking costs one redundant code entry, wrongly
 * letting through costs the second factor entirely.
 */
export function needsSecondFactor(session: Session | null): boolean {
  if (!session) return false;
  if (!hasVerifiedSecondFactor(session.user)) return false;
  return decodeAalClaim(session.access_token) !== 'aal2';
}

/**
 * Room for a six-digit code with the space authenticator apps show in the
 * middle ("123 456"), so a pasted code isn't cut to five digits.
 */
export const TOTP_INPUT_MAX_LENGTH = 7;

/** What a code field keeps of a keystroke or paste: digits and spaces. */
export function cleanTotpInput(value: string): string {
  return value.replace(/[^\d\s]/g, '');
}

/** The six digits of a code as typed or pasted, or null if it isn't six digits. */
export function normalizeTotpCode(input: string): string | null {
  const digits = input.replace(/\s+/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

export const TOTP_CODE_FORMAT_ERROR = 'Enter the 6-digit code from your authenticator app.';

/** Supabase's answer to a code that didn't match. */
export function isWrongTotpCode(message: string): boolean {
  return /invalid totp code|code is incorrect/i.test(message);
}

/** A verify failure as the person should read it. */
export function friendlyTotpError(message: string): string {
  return isWrongTotpCode(message)
    ? "That code didn't match. Codes change every 30 seconds — try the current one."
    : message;
}
