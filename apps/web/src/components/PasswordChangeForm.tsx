import { useState } from 'react';
import * as Sentry from '@sentry/react';
import { updatePassword } from '../services/auth';

interface PasswordChangeFormProps {
  accessToken: string;
  // False for accounts that have only ever signed in with a magic link. Those users
  // have no current password to type, so the field is hidden and the submit takes the
  // client-side path below instead of /api/me/password.
  hasPassword: boolean;
}

export function PasswordChangeForm({ accessToken, hasPassword }: PasswordChangeFormProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Changing an existing password goes through /api/me/password, which verifies the old
  // one. Setting a first password can't: there is nothing to verify against. It uses
  // supabase.auth.updateUser instead — the same call ResetPasswordPage and PasswordSection
  // make — which Supabase authorizes on the session alone and which stamps has_password,
  // so /settings shows the change form from then on.
  //
  // Deliberately NOT done by making current_password optional on /api/me/password: the
  // only thing that endpoint could check to allow the omission is user_metadata.has_password,
  // and user_metadata is writable by the user themselves. Trusting it there would let anyone
  // holding a session clear the flag and change the password without knowing the old one.
  async function setFirstPassword(): Promise<string | null> {
    const { error: updateError } = await updatePassword(newPassword);
    return updateError;
  }

  async function changeExistingPassword(): Promise<string | null> {
    const response = await fetch('/api/me/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });

    const data = await response.json();
    if (!response.ok) return data.error || 'Failed to update password.';
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (hasPassword && !currentPassword) {
      setError('Current password is required.');
      return;
    }

    if (newPassword.length < 8) {
      setError(hasPassword ? 'New password must be at least 8 characters.' : 'Password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(hasPassword ? 'New passwords do not match.' : 'Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const submitError = hasPassword ? await changeExistingPassword() : await setFirstPassword();

      if (submitError) {
        setError(submitError);
      } else {
        setSuccess(hasPassword ? 'Password updated.' : 'Password set. You can now sign in with your email and password.');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'settings.passwordChange', hasPassword } });
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {!hasPassword && (
        <p className="text-sm text-text-muted">
          Your account was created with a magic link. Set a password to sign in with it as well.
        </p>
      )}

      {hasPassword && (
        <div>
          <label htmlFor="current-password" className="block text-sm font-medium mb-1">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            required
            value={currentPassword}
            onChange={e => { setCurrentPassword(e.target.value); setError(null); setSuccess(null); }}
            className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
          />
        </div>
      )}

      <div>
        <label htmlFor="new-password" className="block text-sm font-medium mb-1">
          {hasPassword ? 'New password' : 'Password'}
        </label>
        <input
          id="new-password"
          type="password"
          required
          minLength={8}
          value={newPassword}
          onChange={e => { setNewPassword(e.target.value); setError(null); setSuccess(null); }}
          placeholder="At least 8 characters"
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
        />
        <p className="text-xs text-text-muted mt-1">Use at least 8 characters.</p>
      </div>

      <div>
        <label htmlFor="confirm-password" className="block text-sm font-medium mb-1">
          {hasPassword ? 'Confirm new password' : 'Confirm password'}
        </label>
        <input
          id="confirm-password"
          type="password"
          required
          minLength={8}
          value={confirmPassword}
          onChange={e => { setConfirmPassword(e.target.value); setError(null); setSuccess(null); }}
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
        />
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
        {loading ? (hasPassword ? 'Updating...' : 'Saving...') : (hasPassword ? 'Update password' : 'Set password')}
      </button>
    </form>
  );
}
