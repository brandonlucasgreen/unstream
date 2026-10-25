import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

/**
 * Turn off an existing private release feed, from /settings.
 *
 * The feed itself is subscribed to on /my-collection, under Releases — and that section only
 * renders once a fan has saved somebody, deliberately, because a feed of nobody carries nothing.
 * A *token*, though, outlives the thing that made it: a fan who minted one, pasted the URL
 * somewhere it leaked, and later cleared their saved artists would otherwise have no way to
 * revoke it. Revoking a credential belongs with the account controls anyway, so this is the one
 * feed control that lives here. **It is not a second subscribe entry point** — there is no
 * create and no rotate, and it must not grow one.
 *
 * It deliberately **asks nothing on mount**: GET /api/me/feed-token mints a token when none
 * exists, so probing "do you have one?" would create the very credential this is here to
 * destroy. DELETE is idempotent, so the switch can be offered without knowing, and the copy is
 * true either way — afterwards, any link there was has stopped working.
 */
export function ReleaseFeedOffSwitch() {
  const { session } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function turnOff() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/me/feed-token', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.status === 429) {
        setError(RATE_LIMIT_MESSAGE);
        return;
      }
      if (!res.ok) throw new Error(`feed-token DELETE failed: ${res.status}`);
      setDone(true);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'ReleaseFeedOffSwitch.turnOff' } });
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">
        Subscribe to your private calendar and RSS links under Releases on{' '}
        <Link to="/my-collection" className="text-link hover:underline">My Collection</Link>.
        If you've created one and want it to stop working — you shared it by accident, or you're
        done with it — turn it off here.
      </p>

      {error && <p className="text-sm text-error">{error}</p>}

      {done ? (
        <p className="text-sm text-text-secondary">
          Turned off. Any link you had has stopped working, and anything subscribed to it will stop
          updating. You can create a new one from My Collection whenever you like.
        </p>
      ) : confirming ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={turnOff}
            disabled={busy}
            className="px-3 py-2 rounded-lg bg-red-500/90 text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Turning off…' : 'Yes, break existing subscriptions'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-bg-primary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="px-3 py-2 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary hover:bg-bg-primary"
        >
          Turn off my release feed
        </button>
      )}
    </div>
  );
}
