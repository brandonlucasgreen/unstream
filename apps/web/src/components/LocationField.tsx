import { useState } from 'react';

const MAX_LENGTH = 100;

interface LocationFieldProps {
  currentLocation: string | null;
  accessToken: string;
  onSaved: (location: string | null) => void;
}

export function LocationField({ currentLocation, accessToken, onSaved }: LocationFieldProps) {
  const [location, setLocation] = useState(currentLocation || '');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmed = location.trim();

    if (trimmed.length > MAX_LENGTH) {
      setError(`Location must be ${MAX_LENGTH} characters or fewer.`);
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/me/location', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ location: trimmed || null }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to update location.');
      } else {
        setSuccess('Location saved.');
        onSaved(data.location);
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  const isUnchanged = location.trim() === (currentLocation || '').trim();

  return (
    <form onSubmit={handleSave} className="space-y-3">
      <div>
        <label htmlFor="location" className="block text-sm font-medium mb-1">
          Location
        </label>
        <input
          id="location"
          type="text"
          value={location}
          onChange={e => { setLocation(e.target.value); setError(null); setSuccess(null); }}
          placeholder="e.g. Brooklyn, NY"
          maxLength={MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
        />
        <p className="text-xs text-text-muted mt-1">
          Shown on your public profile if you enable sharing. Optional.
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
        disabled={loading || isUnchanged}
        className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
      >
        {loading ? 'Saving...' : 'Save location'}
      </button>
    </form>
  );
}