import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

// Settings section for connecting a Bandcamp collection via Bandcamp's Subsonic API
// (open beta). The credential goes straight to /api/me/bandcamp over one POST and is never
// kept in client state longer than the request — see api/functions/me-bandcamp.ts for the
// server-side handling.

interface ConnectionStatus {
  connected: boolean;
  username?: string;
  syncStatus?: 'idle' | 'syncing' | 'error';
  syncError?: string | null;
  itemCount?: number | null;
  lastSyncedAt?: string | null;
}

/**
 * How long to wait before the next status check, given how long the sync has been running.
 *
 * People watch closely for the first few seconds and not at all after that, so the gap
 * widens. The ceiling on all of this is the server's, not ours: me-bandcamp.ts reports a
 * sync as failed once it has been 'syncing' for STALE_SYNC_MS (20 minutes), which flips
 * syncStatus and ends the poll. A flat 5s spent ~240 requests reaching that point; this
 * spends ~58, with no perceptible change while anyone is actually looking.
 */
function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 60_000) return 5_000;
  if (elapsedMs < 5 * 60_000) return 15_000;
  return 30_000;
}

export function BandcampConnect() {
  const { session } = useAuth();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [credential, setCredential] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  /**
   * Returns false when the caller should stop polling.
   *
   * Only a 429 stops it. Continuing to poll a rate-limited endpoint re-spends the budget
   * the moment it refills, so the poll can never recover on its own — it just holds a
   * share of the user's account budget until the sync goes stale. An ordinary error is
   * different: it may well be transient, and the widening delay already bounds the cost.
   */
  const fetchStatus = useCallback(async (): Promise<boolean> => {
    if (!session) return false;
    try {
      const res = await fetch('/api/me/bandcamp', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      if (res.status === 429) {
        setError(RATE_LIMIT_MESSAGE);
        return false;
      }
      if (!res.ok) throw new Error('Failed to fetch Bandcamp connection status');
      setStatus(await res.json());
      return true;
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'BandcampConnect.fetchStatus' } });
      setError('Failed to load Bandcamp connection status.');
      return true;
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // While a sync runs in the background, keep the status fresh. A self-scheduling timeout
  // rather than setInterval, because the gap widens as the sync goes on (pollDelayMs).
  useEffect(() => {
    if (status?.syncStatus !== 'syncing') return;

    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    // Set when a tick is skipped for a hidden tab, so returning to the tab refreshes
    // immediately instead of waiting out a 30s gap — and so flipping between tabs
    // without missing anything costs no requests at all.
    let missedWhileHidden = false;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(tick, pollDelayMs(Date.now() - startedAt));
    };

    const tick = async () => {
      // Nobody is watching a hidden tab's status, so don't spend a request refreshing it.
      if (document.hidden) {
        missedWhileHidden = true;
        schedule();
        return;
      }
      const keepPolling = await fetchStatus();
      if (keepPolling) schedule();
    };

    const onVisible = async () => {
      if (document.hidden || !missedWhileHidden || cancelled) return;
      missedWhileHidden = false;
      clearTimeout(timer);
      const keepPolling = await fetchStatus();
      if (keepPolling) schedule();
    };

    document.addEventListener('visibilitychange', onVisible);
    schedule();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status?.syncStatus, fetchStatus]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/me/bandcamp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ username: username.trim(), password: credential }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to connect Bandcamp');
      }
      setCredential('');
      setUsername('');
      setStatus({
        connected: true,
        username: data.username,
        syncStatus: data.syncStatus,
        syncError: data.syncError,
        itemCount: null,
        lastSyncedAt: null,
      });
    } catch (e) {
      // Deliberately no Sentry here: a connect failure message is expected user-facing
      // feedback (bad credential, Bandcamp down), and the exception path must never risk
      // carrying form contents.
      setError(e instanceof Error ? e.message : 'Failed to connect Bandcamp.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResync = async () => {
    if (!session || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/me/bandcamp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ resync: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to start sync');
      setStatus(data);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'BandcampConnect.resync' } });
      setError(e instanceof Error ? e.message : 'Failed to start sync.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async (deleteItems: boolean) => {
    if (!session || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/me/bandcamp', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ deleteItems }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to disconnect');
      setStatus({ connected: false });
      setConfirmingDisconnect(false);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'BandcampConnect.disconnect' } });
      setError(e instanceof Error ? e.message : 'Failed to disconnect.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <p className="text-sm text-text-muted">Loading Bandcamp connection…</p>;
  }

  if (!status) {
    return error ? <p className="text-sm text-red-400">{error}</p> : null;
  }

  if (!status.connected) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          Import the music you've bought on Bandcamp into your collection. This reads your
          collection and never changes anything on Bandcamp.
        </p>
        <ol className="list-decimal list-inside text-sm text-text-muted space-y-1">
          <li>
            Open{' '}
            <a
              href="https://bandcamp.com/settings?pane=fan"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-primary hover:underline"
            >
              Bandcamp's Fan Settings
            </a>{' '}
            and turn on <strong className="text-text-primary">Subsonic</strong>. Bandcamp shows
            you a server address, a username, and a password.
          </li>
          <li>
            Paste the username and password below. Skip the server address — it's always the
            same, and Unstream fills it in.
          </li>
        </ol>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <form onSubmit={handleConnect} className="space-y-3">
          <div>
            <label htmlFor="bandcamp-username" className="block text-sm text-text-primary mb-1">
              Username (from Bandcamp)
            </label>
            <input
              id="bandcamp-username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="off"
              className="w-full max-w-sm px-3 py-2 rounded-lg bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
            />
          </div>
          <div>
            <label htmlFor="bandcamp-credential" className="block text-sm text-text-primary mb-1">
              Password (from Bandcamp)
            </label>
            <input
              id="bandcamp-credential"
              type="password"
              value={credential}
              onChange={e => setCredential(e.target.value)}
              autoComplete="off"
              className="w-full max-w-sm px-3 py-2 rounded-lg bg-bg-primary border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !username.trim() || !credential}
            className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Connecting…' : 'Connect Bandcamp'}
          </button>
        </form>
        <p className="text-xs text-text-muted">
          Bandcamp's Subsonic support is in beta and may change or break. Your credential is
          stored encrypted, and you can disconnect — and delete everything imported — at any time.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">
        Connected as <strong className="text-text-primary">{status.username}</strong>
      </p>

      {status.syncStatus === 'syncing' && (
        <p className="text-sm text-text-muted" role="status">
          Importing your collection… Large collections can take a while in Bandcamp's beta.
          You can leave this page.
        </p>
      )}

      {status.syncStatus === 'error' && status.syncError && (
        <p className="text-sm text-red-400">{status.syncError}</p>
      )}

      {status.syncStatus === 'idle' && (
        <p className="text-sm text-text-muted">
          {status.itemCount != null ? `${status.itemCount} releases imported` : 'Imported'}
          {status.lastSyncedAt
            ? ` · last synced ${new Date(status.lastSyncedAt).toLocaleDateString()}`
            : ''}
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {!confirmingDisconnect ? (
        <div className="flex gap-3">
          {status.syncStatus !== 'syncing' && (
            <button
              type="button"
              onClick={handleResync}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-primary disabled:opacity-50"
            >
              Re-sync
            </button>
          )}
          <button
            type="button"
            onClick={() => setConfirmingDisconnect(true)}
            disabled={submitting}
            className="px-3 py-1.5 rounded-lg border border-border text-sm text-red-400 hover:bg-bg-primary disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-text-primary">
            Disconnect Bandcamp? Your stored credential is deleted either way — choose what
            happens to the releases already imported.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => handleDisconnect(false)}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-primary disabled:opacity-50"
            >
              Disconnect, keep items
            </button>
            <button
              type="button"
              onClick={() => handleDisconnect(true)}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-border text-sm text-red-400 hover:bg-bg-primary disabled:opacity-50"
            >
              Disconnect and delete items
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDisconnect(false)}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg text-sm text-text-muted hover:text-text-primary disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
