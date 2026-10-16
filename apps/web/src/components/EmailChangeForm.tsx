import { useState } from 'react';
import * as Sentry from '@sentry/react';

interface EmailChangeFormProps {
  accessToken: string;
  /** The address currently on the account. */
  currentEmail: string;
  /** A pending change to confirm (from me-settings), so the UI can show it. */
  pendingEmail: string | null;
  /** Called after a new request starts or a pending one is cancelled, so the page refetches. */
  onPendingChange: (pendingEmail: string | null) => void;
}

// Same shape as LoginPage's EMAIL_PATTERN — type="email" only validates on native form
// submit, and the submit here is a button with an onClick-driven handler path, so the
// explicit check is what a mistyped address actually hits.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/me/email with a new address, or DELETE to cancel the pending one.
// The endpoint answers 202 with { pending, new_email } on request and
// { cancelled: true } on cancel.
export function EmailChangeForm({ accessToken, currentEmail, pendingEmail, onPendingChange }: EmailChangeFormProps) {
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function requestChange(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmed = newEmail.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError("That email address doesn't look right. Check it and try again.");
      return;
    }
    if (trimmed.toLowerCase() === currentEmail.toLowerCase()) {
      setError('That is already your email address.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/me/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ new_email: trimmed }),
      });

      if (response.status === 429) {
        setError('Too many requests. Please wait a minute and try again.');
      } else {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setError(data.error || 'Failed to start the email change. Please try again.');
        } else {
          setSuccess(`Confirmation sent to ${data.new_email || trimmed}. The address on your account doesn't change until you confirm from that inbox.`);
          onPendingChange(data.new_email || trimmed);
          setNewEmail('');
        }
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'settings.emailChange.request' } });
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function cancelChange() {
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const response = await fetch('/api/me/email', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (response.ok) {
        onPendingChange(null);
      } else {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Could not cancel the pending change. Please try again.');
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'settings.emailChange.cancel' } });
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  return (
    <div className="space-y-3">
      {pendingEmail && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-400 flex flex-wrap items-center justify-between gap-2">
          <span>
            Change to <strong className="text-amber-300">{pendingEmail}</strong> is waiting for confirmation. Check that inbox for the link.
          </span>
          <button
            type="button"
            onClick={cancelChange}
            disabled={loading}
            className="px-3 py-1 rounded-md text-xs font-medium text-amber-300 border border-amber-500/40 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
          >
            Cancel change
          </button>
        </div>
      )}

      <p className="text-sm text-text-muted">
        Signed in as <strong className="text-text-primary">{currentEmail}</strong>
      </p>

      <form onSubmit={requestChange} className="space-y-3">
        <div>
          <label htmlFor="new-email" className="block text-sm font-medium mb-1">
            New email address
          </label>
          <input
            id="new-email"
            type="email"
            required
            value={newEmail}
            onChange={e => { setNewEmail(e.target.value); setError(null); setSuccess(null); }}
            placeholder="you@example.com"
            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
          />
          <p className="text-xs text-text-muted mt-1">
            We'll send a confirmation link there. Your account keeps its current address until you confirm.
          </p>
        </div>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        {success && !error && (
          <p className="text-sm text-green-400">{success}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
        >
          {loading ? 'Sending...' : 'Change email'}
        </button>
      </form>
    </div>
  );
}