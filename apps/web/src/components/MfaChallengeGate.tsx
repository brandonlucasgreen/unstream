import { useState } from 'react';
import type { Session, Factor } from '@supabase/supabase-js';
import { verifyTotp, verifyWithPasskey, passkeysSupported } from '../services/mfa';

interface MfaChallengeGateProps {
  /** The aal1 session waiting on its second factor. Its user carries the factors. */
  session: Session;
  onSignOut: () => void;
}

/**
 * The screen the whole app is held behind while a session that belongs to a
 * two-step account hasn't completed its second factor (aal1). Rendered by
 * AuthContext in place of the app, so it covers every way an aal1 session can
 * appear: a password sign-in, a magic-link click-through, or a session issued
 * before this feature shipped. A successful verification reissues the session at
 * aal2 through onAuthStateChange, and the gate lifts on its own — nothing here
 * needs to navigate.
 *
 * Props rather than useAuth on purpose: AuthContext renders this component, and
 * having it reach back into AuthContext would be a circular import for two
 * values it can simply be handed.
 */
export function MfaChallengeGate({ session, onSignOut }: MfaChallengeGateProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const factors = (session.user.factors ?? []).filter(
    (f: Factor) => f.status === 'verified',
  );
  // With more than one authenticator app enrolled, codes differ per factor, so
  // the challenge runs against the newest — the app they most likely still have.
  const totpFactor = factors
    .filter(f => f.factor_type === 'totp')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .at(-1);
  const passkeyFactor = factors.find(f => f.factor_type === 'webauthn');
  const showPasskey = !!passkeyFactor && passkeysSupported();

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    if (!totpFactor) return;

    setBusy(true);
    setError(null);
    const { error: verifyError } = await verifyTotp(totpFactor.id, trimmed);
    if (verifyError) {
      setError(
        /invalid totp code|code is incorrect/i.test(verifyError)
          ? "That code didn't match. Codes change every 30 seconds — try the current one."
          : verifyError,
      );
      setBusy(false);
    }
    // On success the fresh aal2 session arrives via onAuthStateChange and the
    // gate lifts; there is nothing to do here, and `busy` staying on for the
    // moment between is the right thing (a second submit can't race it).
  }

  async function handlePasskey() {
    if (!passkeyFactor) return;
    setBusy(true);
    setError(null);
    const { error: passkeyError, cancelled } = await verifyWithPasskey(passkeyFactor.id);
    if (cancelled) {
      // The person backed out of the browser prompt; let them try again or
      // use a code if they have one.
      setBusy(false);
      return;
    }
    if (passkeyError) {
      setError(passkeyError);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <p className="text-sm font-semibold uppercase tracking-wide text-text-muted">Unstream</p>
          <h1 className="text-2xl font-bold">Two-step verification</h1>
          <p className="text-text-muted text-sm">
            Signing in as <strong className="text-text-primary">{session.user.email}</strong>.
            Finish with your second step to continue.
          </p>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-error text-sm">
            {error}
          </div>
        )}

        {showPasskey && (
          <>
            <button
              type="button"
              onClick={handlePasskey}
              disabled={busy}
              className="w-full py-2 rounded-lg bg-accent-primary text-accent-foreground font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
            >
              {busy ? 'Waiting for your passkey…' : 'Use your passkey'}
            </button>

            {totpFactor && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-bg-primary px-2 text-text-muted">or</span>
                </div>
              </div>
            )}
          </>
        )}

        {totpFactor && (
          <form onSubmit={handleVerifyCode} className="space-y-4">
            <div>
              <label htmlFor="mfa-code" className="block text-sm font-medium mb-1">
                Code from your authenticator app
              </label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                value={code}
                onChange={e => {
                  setCode(e.target.value.replace(/[^\d\s]/g, ''));
                  setError(null);
                }}
                placeholder="123 456"
                disabled={busy}
                className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary disabled:opacity-50 text-center tracking-widest"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2 rounded-lg bg-accent-primary text-accent-foreground font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </form>
        )}

        <div className="text-center space-y-2">
          <button
            type="button"
            onClick={onSignOut}
            className="text-sm text-link hover:underline"
          >
            Sign out instead
          </button>
          <p className="text-xs text-text-muted">
            Lost access to your second step? Email support@unstream.stream and we can help.
          </p>
        </div>
      </div>
    </div>
  );
}
