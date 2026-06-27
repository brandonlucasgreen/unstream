import { useState } from 'react';

interface PasswordChangeFormProps {
  accessToken: string;
}

export function PasswordChangeForm({ accessToken }: PasswordChangeFormProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!currentPassword) {
      setError('Current password is required.');
      return;
    }

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/me/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to update password.');
      } else {
        setSuccess('Password updated.');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
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

      <div>
        <label htmlFor="new-password" className="block text-sm font-medium mb-1">
          New password
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
          Confirm new password
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
        {loading ? 'Updating...' : 'Update password'}
      </button>
    </form>
  );
}