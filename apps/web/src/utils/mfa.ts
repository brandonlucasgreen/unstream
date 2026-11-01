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
