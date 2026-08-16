import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

interface Preferences {
  newRelease: boolean;
  newPlatformLink: boolean;
  weeklyAnalyticsRecap: boolean;
}

/**
 * The weekly analytics recap is deliberately absent: it is paused at the sender
 * (.github/workflows/weekly-analytics-recap.yml has no schedule), and a switch for an email
 * nobody receives is a promise the product doesn't keep. The preference itself is untouched —
 * still stored, still returned by the API, still honored — so restoring this entry alongside
 * the schedule brings back whatever each artist had already chosen.
 */
const TOGGLES: { key: keyof Preferences; label: string; description: string }[] = [
  {
    key: 'newRelease',
    label: 'New releases',
    description: 'When an artist you saved puts out a new release.',
  },
  {
    key: 'newPlatformLink',
    label: 'New places to support',
    description: 'When an artist you saved adds a link to a new platform.',
  },
];

export function NotificationPreferences() {
  const { session } = useAuth();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [togglingKey, setTogglingKey] = useState<keyof Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchPreferences = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/me/notification-preferences', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      if (res.status === 429) {
        setError(RATE_LIMIT_MESSAGE);
        return;
      }
      if (!res.ok) throw new Error('Failed to fetch notification preferences');
      const data = await res.json();
      setPreferences(data);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'NotificationPreferences.fetchPreferences' } });
      setError('Failed to load notification preferences.');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    fetchPreferences();
  }, [fetchPreferences]);

  const handleToggle = async (key: keyof Preferences) => {
    if (!session || !preferences) return;
    const next = !preferences[key];
    setTogglingKey(key);
    setError(null);
    try {
      const res = await fetch('/api/me/notification-preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update notification preferences');
      }
      const data = await res.json();
      setPreferences(data);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'NotificationPreferences.toggle', key } });
      setError(e instanceof Error ? e.message : 'Failed to update notification preferences.');
    } finally {
      setTogglingKey(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading notification preferences…</p>;
  }

  if (!preferences) {
    return error ? <p className="text-sm text-red-400">{error}</p> : null;
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {TOGGLES.map(({ key, label, description }) => {
        const enabled = preferences[key];
        const busy = togglingKey === key;
        return (
          <div key={key} className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-text-primary">{label}</p>
              <p className="text-xs text-text-muted">{description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={label}
              disabled={busy}
              onClick={() => handleToggle(key)}
              className={`shrink-0 mt-0.5 relative w-10 h-6 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                enabled ? 'bg-accent-secondary' : 'bg-border'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}
