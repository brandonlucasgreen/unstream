// Two-step verification (MFA) on Supabase Auth. Every call here goes from the
// browser straight to Supabase — no Unstream API function is involved, so none
// of it spends the site's Redis or API rate-limit budget. Setup UI lives in the
// /settings "Two-step verification" section; the sign-in challenge lives in
// MfaChallengeGate. See docs/specs/two-factor-auth-spec.md for the model.

import type { Factor, FactorType } from '@supabase/supabase-js';
import * as Sentry from '@sentry/react';
import { getSupabaseClient } from './auth';
import { isWrongTotpCode } from '../utils/mfa';

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
 * Report an MFA failure Supabase *returned* rather than threw. A wrong code is
 * the user's own doing and constant, so like `reportAuthFailure` in
 * services/auth.ts it's excluded (a cancelled passkey prompt never gets here —
 * see isCancelledPrompt). What's left — rate limits, a misconfigured WebAuthn
 * provider or RP ID, 5xx — is worth waking up to.
 */
function reportMfaFailure(operation: string, error: Error): void {
  if (isWrongTotpCode(error.message)) return;

  Sentry.captureMessage(`MFA failed: ${operation}`, {
    level: 'warning',
    tags: { context: 'auth.service', mfa_operation: operation },
    extra: { errorMessage: error.message, errorName: error.name },
  });
}

/**
 * Supabase factor names must be unique per account, so a fixed name would make
 * every second authenticator app or passkey fail to enroll. The UI labels
 * factors by type and date, so the name only has to be distinct.
 */
function uniqueFriendlyName(base: string): string {
  return `${base} ${new Date().toISOString()}`;
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
  await Promise.all(
    data.all
      .filter(factor => factor.status === 'unverified')
      .map(factor => supabase.auth.mfa.unenroll({ factorId: factor.id })),
  );
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
    friendlyName: uniqueFriendlyName('Authenticator app'),
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
 * Whether a passkey failure is the person backing out of the browser prompt —
 * no error text, no Sentry report, nothing to stop them trying again. Browsers
 * report a dismissed prompt as NotAllowedError, which auth-js passes through as
 * the error's name; an aborted ceremony has its own code.
 */
function isCancelledPrompt(error: Error): boolean {
  return error.name === 'NotAllowedError'
    || (error as Error & { code?: string }).code === 'ERROR_CEREMONY_ABORTED';
}

/**
 * The rp id and origin describe *this page*, not a constant: a ceremony only
 * succeeds when they match what Supabase was configured with (see the spec —
 * this is why passkeys work on unstream.stream but not on localhost or a
 * deploy preview).
 */
function currentRelyingParty() {
  return { rpId: window.location.hostname, rpOrigins: [window.location.origin] };
}

/**
 * Enroll a passkey: auth-js's register() creates the factor, runs the browser's
 * create ceremony and verifies it. An enrollment that ends without a
 * verification leaves an unverified factor behind, which the next enrollment
 * clears (unenrollUnverifiedFactors) and the settings list never shows.
 */
export async function enrollPasskey(): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  await unenrollUnverifiedFactors();
  const { error } = await supabase.auth.mfa.webauthn.register({
    friendlyName: uniqueFriendlyName('Passkey'),
    webauthn: currentRelyingParty(),
  });
  if (!error) return { error: null };
  if (isCancelledPrompt(error)) return { error: null };
  reportMfaFailure('enrollPasskey', error);
  return { error: error.message || 'The passkey prompt failed. Try again.' };
}

/** The sign-in step: prove with a passkey the account has already enrolled. */
export async function verifyWithPasskey(factorId: string): Promise<{ error: string | null; cancelled: boolean }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured', cancelled: false };

  const { error } = await supabase.auth.mfa.webauthn.authenticate({
    factorId,
    webauthn: currentRelyingParty(),
  });
  if (!error) return { error: null, cancelled: false };
  if (isCancelledPrompt(error)) return { error: null, cancelled: true };
  reportMfaFailure('verifyWithPasskey', error);
  return { error: error.message || 'The passkey prompt failed. Try again.', cancelled: false };
}
