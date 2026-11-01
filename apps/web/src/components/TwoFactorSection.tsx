import { useCallback, useEffect, useState } from 'react';
import {
  listMfaFactors,
  enrollTotp,
  verifyTotp,
  unenrollFactor,
  type MfaFactor,
  type TotpEnrollment,
} from '../services/mfa';
import {
  TOTP_CODE_FORMAT_ERROR,
  TOTP_INPUT_MAX_LENGTH,
  cleanTotpInput,
  friendlyTotpError,
  normalizeTotpCode,
} from '../utils/mfa';

/**
 * The enrollment half of two-step verification, mounted in the "Two-step
 * verification" section of /settings. (The other half is MfaChallengeGate at
 * sign-in.) Everything it does goes from the browser straight to Supabase Auth
 * via services/mfa.ts — no Unstream API function is involved.
 */
export function TwoFactorSection() {
  const [factors, setFactors] = useState<MfaFactor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The confirm step of removing a factor: the first click reveals the real
  // button, so one stray tap can't switch off someone's security.
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { factors: fresh, error } = await listMfaFactors();
    if (error) {
      setLoadError(error);
      return;
    }
    setFactors(fresh);
    setLoadError(null);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const verified = (factors ?? []).filter(f => f.status === 'verified');

  async function handleAddTotp() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { enrollment: fresh, error: enrollError } = await enrollTotp();
    setBusy(false);
    if (enrollError || !fresh) {
      setError(enrollError ?? 'Could not start adding an authenticator app.');
      return;
    }
    setEnrollment(fresh);
    setCode('');
  }

  async function handleCancelEnrollment() {
    if (!enrollment) return;
    // The factor exists server-side until unenrolled; an abandoned enrollment
    // would otherwise linger as an unverified factor.
    await unenrollFactor(enrollment.factorId);
    setEnrollment(null);
    setCode('');
    setError(null);
    reload();
  }

  async function handleVerifyEnrollment() {
    if (!enrollment) return;
    const normalized = normalizeTotpCode(code);
    if (!normalized) {
      setError(TOTP_CODE_FORMAT_ERROR);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: verifyError } = await verifyTotp(enrollment.factorId, normalized);
    setBusy(false);
    if (verifyError) {
      setError(friendlyTotpError(verifyError));
      return;
    }
    setEnrollment(null);
    setCode('');
    setNotice('Two-step verification is on. You will be asked for a code at sign-in.');
    reload();
  }

  async function handleRemove(factorId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: removeError } = await unenrollFactor(factorId);
    setBusy(false);
    setConfirmingRemoveId(null);
    if (removeError) {
      setError(removeError);
      return;
    }
    reload();
  }

  if (factors === null && !loadError) {
    return <p className="text-sm text-text-muted">Loading…</p>;
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-error">{loadError}</p>
        <button
          type="button"
          onClick={() => reload()}
          className="text-sm text-link hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (enrollment) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          Scan this code with your authenticator app (1Password, Google Authenticator,
          Aegis and the rest all work). Can't scan? Enter the secret below by hand.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 items-start">
          <img
            src={enrollment.qrCode}
            alt="QR code for your authenticator app"
            className="w-40 h-40 bg-white p-2 rounded-lg border border-border"
          />
          <div className="space-y-2">
            <p className="text-sm font-medium">Secret</p>
            <code className="block px-2 py-1 rounded bg-bg-primary border border-border text-sm break-all select-all">
              {enrollment.secret}
            </code>
            <p className="text-xs text-text-muted">
              Keep this secret somewhere safe. Without it, losing the app means
              losing the account until support can step in.
            </p>
          </div>
        </div>
        <div>
          <label htmlFor="totp-code" className="block text-sm font-medium mb-1">
            Code from the app
          </label>
          <input
            id="totp-code"
            type="text"
            inputMode="numeric"
            maxLength={TOTP_INPUT_MAX_LENGTH}
            value={code}
            onChange={e => {
              setCode(cleanTotpInput(e.target.value));
              setError(null);
            }}
            placeholder="123 456"
            className="w-40 px-3 py-2 rounded-lg bg-bg-primary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary text-center tracking-widest"
          />
        </div>
        {error && <p className="text-sm text-error">{error}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleVerifyEnrollment}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-accent-primary text-accent-foreground text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify and turn on'}
          </button>
          <button
            type="button"
            onClick={handleCancelEnrollment}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        {verified.length > 0
          ? 'On. Your account asks for a second step at sign-in.'
          : 'Off. Add a second step to sign-in — a code from an authenticator app — so a stolen password alone is not enough to take over your account.'}
      </p>

      {notice && <p className="text-sm text-success">{notice}</p>}
      {error && <p className="text-sm text-error">{error}</p>}

      {verified.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {verified.map(factor => (
            <li key={factor.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div>
                <p className="text-sm font-medium">
                  {factor.type === 'totp' ? 'Authenticator app' : 'Other second step'}
                </p>
                <p className="text-xs text-text-muted">
                  Added {new Date(factor.createdAt).toLocaleDateString()}
                </p>
              </div>
              {confirmingRemoveId === factor.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">Remove it?</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(factor.id)}
                    disabled={busy}
                    className="text-sm text-error hover:underline disabled:opacity-50"
                  >
                    Yes, remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRemoveId(null)}
                    disabled={busy}
                    className="text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRemoveId(factor.id)}
                  disabled={busy}
                  className="text-sm text-text-secondary hover:text-error transition-colors disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={handleAddTotp}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-accent-primary text-accent-foreground text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add authenticator app'}
        </button>
      </div>
    </div>
  );
}
