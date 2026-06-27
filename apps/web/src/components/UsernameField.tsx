import { useState } from 'react';

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;

interface UsernameFieldProps {
  currentUsername: string | null;
  accessToken: string;
  onSaved: (username: string) => void;
}

export function UsernameField({ currentUsername, accessToken, onSaved }: UsernameFieldProps) {
  const [username, setUsername] = useState(currentUsername || '');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmed = username.trim();

    if (!trimmed) {
      setError('Username is required.');
      return;
    }

    if (!USERNAME_REGEX.test(trimmed)) {
      setError('Username must be 3-20 characters, lowercase letters, numbers, and hyphens. No leading or trailing hyphens.');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/me/username', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ username: trimmed }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to update username.');
      } else {
        setSuccess('Username saved.');
        onSaved(data.username);
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div>
        <label htmlFor="username" className="block text-sm font-medium mb-1">
          Username
        </label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={e => { setUsername(e.target.value); setError(null); setSuccess(null); }}
          placeholder="e.g. kidlightbulbs"
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
        />
        <p className="text-xs text-text-muted mt-1">
          Your username is used in the public URL when you share your saved artists. 3-20 characters, lowercase letters, numbers, and hyphens.
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
        disabled={loading || username.trim() === (currentUsername || '')}
        className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? 'Saving...' : 'Save username'}
      </button>
    </form>
  );
}