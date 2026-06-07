import { useState } from 'react';
import * as Sentry from '@sentry/react';
import { updatePassword } from '../services/auth';
import { useAuth } from '../contexts/AuthContext';

export function PasswordSection() {
  const { hasPassword } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await updatePassword(newPassword);
      if (updateError) {
        setError(updateError);
      } else {
        setSuccess(hasPassword ? 'Password updated.' : 'Password set. You can now sign in with your email and password.');
        setNewPassword('');
        setConfirmPassword('');
        setExpanded(false);
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.updatePassword' } });
      setError('Something went wrong. Please try again.');
    }
    setLoading(false);
  }

  return (
    <div className="p-4 rounded-lg bg-bg-secondary border border-border space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm">Password</h3>
          <p className="text-xs text-text-muted">
            {hasPassword
              ? 'You can sign in with your password or a magic link.'
              : 'Set a password for faster sign-in, or keep using magic links.'
            }
          </p>
        </div>
        {!expanded && (
          <button
            type="button"
            onClick={() => { setExpanded(true); setError(null); setSuccess(null); }}
            className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors"
          >
            {hasPassword ? 'Change' : 'Set password'}
          </button>
        )}
      </div>

      {success && (
        <div className="p-2 rounded bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
          {success}
        </div>
      )}

      {error && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {expanded && (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="new-pw" className="block text-xs font-medium mb-1">
              {hasPassword ? 'New password' : 'Password'}
            </label>
            <input
              id="new-pw"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-accent-primary"
            />
          </div>
          <div>
            <label htmlFor="confirm-pw" className="block text-xs font-medium mb-1">
              Confirm password
            </label>
            <input
              id="confirm-pw"
              type="password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your password"
              className="w-full px-3 py-2 rounded-lg bg-bg-primary border border-border text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-accent-primary"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-1.5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving...' : hasPassword ? 'Update password' : 'Set password'}
            </button>
            <button
              type="button"
              onClick={() => { setExpanded(false); setNewPassword(''); setConfirmPassword(''); setError(null); }}
              className="px-4 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
