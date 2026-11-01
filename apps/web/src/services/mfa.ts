// Two-step verification (MFA) on Supabase Auth. Every call here goes from the
// browser straight to Supabase — no Unstream API function is involved, so none
// of it spends the site's Redis or API rate-limit budget. Setup UI lives in the
// /settings "Two-step verification" section; the sign-in challenge lives in
// MfaChallengeGate. See docs/specs/two-factor-auth-spec.md for the model.

import type {
  AuthError,
  Factor,
  FactorType,
} from '@supabase/supabase-js';
import * as Sentry from '@sentry/react';
import { getSupabaseClient } from './auth';

/**
 * What `mfa.verify` expects in its `webauthn.credential_response`. auth-js keeps
 * the underlying DOM types in an internal module that neither package re-exports,
 * so the target is derived from the call's own signature — a PublicKeyCredential
 * from the browser satisfies it at runtime.
 */
type MfaVerify = NonNullable<ReturnType<typeof getSupabaseClient>>['auth']['mfa']['verify'];
type WebauthnVerifyParams = Extract<Parameters<MfaVerify>[0], { webauthn: { rpId: string } }>;
type WebauthnCredentialResponse = WebauthnVerifyParams['webauthn']['credential_response'];

/** A factor as the UI sees it — camelCase, only what gets displayed. */
export interface MfaFactor {
  id: string;
  type: FactorType;
  friendlyName: string | null;
  status: Factor['status'];
  createdAt: string;
}

export interface TotpEnrollment {
  factorId: string;
  /** A data: URI ready for an <img src>. */
  qrCode: string;
  /** The secret, for manual entry when the QR can't be scanned. */
  secret: string;
}

/**
 * Report an MFA failure Supabase *returned* rather than threw. Wrong codes and
 * cancelled prompts are the user's own doing and constant, so like
 * `reportAuthFailure` in services/auth.ts they're excluded; what's left —
 * rate limits, a misconfigured provider, 5xx — is worth waking up to.
 */
function reportMfaFailure(operation: string, error: AuthError | Error): void {
  if (isUserMistake(error.message)) return;

  Sentry.captureMessage(`MFA failed: ${operation}`, {
    level: 'warning',
    tags: { context: 'auth.service', mfa_operation: operation },
    extra: { errorMessage: error.message, errorName: error.name },
  });
}

function isUserMistake(message: string): boolean {
  return /invalid totp code|code is incorrect|not allowed|aborted|cancelled|canceled/i.test(message);
}

function toMfaFactor(factor: Factor): MfaFactor {
  return {
    id: factor.id,
    type: factor.factor_type,
    friendlyName: factor.friendly_name ?? null,
    status: factor.status,
    createdAt: factor.created_at,
  };
}

export async function listMfaFactors(): Promise<{ factors: MfaFactor[]; error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { factors: [], error: 'Auth not configured' };

  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) {
    reportMfaFailure('listFactors', error);
    return { factors: [], error: error.message };
  }
  return { factors: data.all.map(toMfaFactor), error: null };
}

/**
 * An enrollment that was never verified lingers as an unverified factor — it
 * can't be challenged, only clutter. Cleared before each new enrollment, so
 * a fresh start never inherits abandoned rows. Cosmetic, so failures are
 * ignored; the next attempt cleans again.
 */
async function unenrollUnverifiedFactors(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) return;
  for (const factor of data.all) {
    if (factor.status === 'unverified') {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }
}

/**
 * supabase-js returns the TOTP QR as SVG markup; a server that already
 * prefixes a data URI passes through untouched. encodeURIComponent keeps the
 * '#' hex colors inside the SVG from reading as a URL fragment.
 */
export function totpQrDataUri(qrCode: string): string {
  if (qrCode.startsWith('data:')) return qrCode;
  return `data:image/svg+xml;utf8,${encodeURIComponent(qrCode)}`;
}

export async function enrollTotp(): Promise<{ enrollment: TotpEnrollment | null; error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { enrollment: null, error: 'Auth not configured' };

  await unenrollUnverifiedFactors();
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Authenticator app',
  });
  if (error || !data.totp) {
    reportMfaFailure('enrollTotp', error ?? new Error('TOTP enrollment returned no secret'));
    return { enrollment: null, error: error?.message ?? 'TOTP enrollment failed' };
  }
  return {
    enrollment: {
      factorId: data.id,
      qrCode: totpQrDataUri(data.totp.qr_code),
      secret: data.totp.secret,
    },
    error: null,
  };
}

export async function verifyTotp(factorId: string, code: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) {
    reportMfaFailure('verifyTotp', error);
    return { error: error.message };
  }
  return { error: null };
}

export async function unenrollFactor(factorId: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) {
    reportMfaFailure('unenroll', error);
    return { error: error.message };
  }
  return { error: null };
}

/** Whether this browser can run a WebAuthn ceremony at all. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && window.isSecureContext;
}

/**
 * One WebAuthn round trip for both ceremonies: ask Supabase for the challenge,
 * run the browser prompt it describes, hand the assertion back. `create` is
 * enrollment (the first tap on a new passkey), `request` is the sign-in step.
 *
 * `cancelled` means the person backed out of the browser prompt — no error
 * text, no Sentry report, nothing to stop them trying again.
 */
async function webauthnChallenge(
  factorId: string,
): Promise<{ error: string | null; cancelled: boolean }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured', cancelled: false };

  // The rp id and origin describe *this page*, not a constant: a ceremony only
  // succeeds when they match what Supabase was configured with (see the spec —
  // this is why passkeys work on unstream.stream but not on localhost).
  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId,
    webauthn: {
      rpId: window.location.hostname,
      rpOrigins: [window.location.origin],
    },
  });
  if (challengeError || !challenge) {
    reportMfaFailure('webauthnChallenge', challengeError ?? new Error('no challenge returned'));
    return { error: challengeError?.message ?? 'Supabase returned no passkey challenge.', cancelled: false };
  }
  if (challenge.type !== 'webauthn' || !challenge.webauthn) {
    return { error: 'Supabase returned a challenge for the wrong factor type.', cancelled: false };
  }

  const ceremony = challenge.webauthn;
  let result: Credential | null = null;
  try {
    result =
      ceremony.type === 'create'
        ? await navigator.credentials.create({
            // auth-js's "Future" options are DOM-compatible at runtime but their
            // types allow transports lib.dom doesn't know about yet ("cable"),
            // which is enough to make the whole options object unassignable.
            publicKey: ceremony.credential_options.publicKey as unknown as PublicKeyCredentialCreationOptions,
          })
        : await navigator.credentials.get({
            publicKey: ceremony.credential_options.publicKey as unknown as PublicKeyCredentialRequestOptions,
          });
  } catch (e) {
    // NotAllowedError is how the browser reports a dismissed prompt.
    if ((e as DOMException)?.name === 'NotAllowedError') {
      return { error: null, cancelled: true };
    }
    reportMfaFailure('webauthnPrompt', e instanceof Error ? e : new Error(String(e)));
    return {
      error:
        e instanceof Error && e.message
          ? e.message
          : 'The passkey prompt failed. Try again.',
      cancelled: false,
    };
  }
  if (!result) {
    // Firefox resolves with null rather than throwing NotAllowedError.
    return { error: null, cancelled: true };
  }
  // CredentialsContainer is typed to the Credential base; a publicKey ceremony
  // always yields a PublicKeyCredential.
  const credential = result as PublicKeyCredential;

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    webauthn: {
      rpId: window.location.hostname,
      type: ceremony.type,
      credential_response: credential as unknown as WebauthnCredentialResponse,
    },
  });
  if (verifyError) {
    reportMfaFailure('webauthnVerify', verifyError);
    return { error: verifyError.message, cancelled: false };
  }
  return { error: null, cancelled: false };
}

/**
 * Enroll the account's passkey: create the factor, run the browser's create
 * ceremony, verify. An enrollment that ends without a verification (error or
 * cancel) unenrolls its orphaned unverified factor, so nothing lingers.
 */
export async function enrollPasskey(): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  await unenrollUnverifiedFactors();
  const { data: factor, error } = await supabase.auth.mfa.enroll({
    factorType: 'webauthn',
    friendlyName: 'Passkey',
  });
  if (error) {
    reportMfaFailure('enrollPasskey', error);
    return { error: error.message };
  }

  const { error: ceremonyError, cancelled } = await webauthnChallenge(factor.id);
  if (ceremonyError || cancelled) {
    await supabase.auth.mfa.unenroll({ factorId: factor.id });
    return { error: cancelled ? null : ceremonyError };
  }
  return { error: null };
}

/** The sign-in step: prove with a passkey the account has already enrolled. */
export async function verifyWithPasskey(factorId: string): Promise<{ error: string | null; cancelled: boolean }> {
  return webauthnChallenge(factorId);
}
