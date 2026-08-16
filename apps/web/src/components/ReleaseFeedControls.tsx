import { useState, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

interface FeedUrls {
  ics: string;
  atom: string;
}

/**
 * Subscribe to a private calendar of upcoming releases from your saved artists.
 *
 * The link is **not fetched on mount.** A feed token is a credential, and one is created the
 * first time it's asked for — so loading /settings shouldn't mint one for every visitor who
 * never wanted a calendar. The user presses a button; that press is the request.
 *
 * The URL is deliberately shown in full rather than hidden behind a copy button alone: calendar
 * clients are subscribed to by pasting a URL, and a user needs to be able to get at it on a
 * second device. It's treated as a secret in the copy ("anyone with this link…") rather than in
 * the markup, which matches how Google and Apple present their own private calendar addresses.
 */
export function ReleaseFeedControls() {
  const { session } = useAuth();
  const [urls, setUrls] = useState<FeedUrls | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ics' | 'atom' | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const call = useCallback(
    async (method: 'GET' | 'POST' | 'DELETE') => {
      if (!session) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/me/feed-token', {
          method,
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.status === 429) {
          setError(RATE_LIMIT_MESSAGE);
          return;
        }
        if (!res.ok) throw new Error(`feed-token ${method} failed: ${res.status}`);

        const data = await res.json();
        setUrls(data.revoked ? null : { ics: data.ics, atom: data.atom });
      } catch (e) {
        Sentry.captureException(e, { extra: { context: 'ReleaseFeedControls.call', method } });
        setError('Something went wrong. Please try again.');
      } finally {
        setBusy(false);
        setConfirmingRotate(false);
      }
    },
    [session]
  );

  const copy = async (which: 'ics' | 'atom', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard can be blocked by permissions; the URL is on screen to copy by hand.
    }
  };

  if (!urls) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-text-muted">
          Subscribe once in Apple Calendar, Google Calendar, or an RSS reader and see everything
          your saved artists have coming — not one subscription per artist.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          onClick={() => call('GET')}
          disabled={busy || !session}
          className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create my feed link'}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        Anyone with these links can see what your saved artists have coming, so treat them like a
        password. Rotating issues new links and stops the old ones working everywhere.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/*
        The extension is in the label as well as the URL. The two links differ *only* in their
        last four characters, which is exactly the part an input this width truncates — so on
        screen they look identical and it's easy to paste the wrong one into a calendar client
        and get nothing. Naming the extension is cheaper than fighting the input's scroll
        position.
      */}
      {([
        { key: 'ics', label: 'Calendar (Apple, Google)', ext: '.ics', value: urls.ics },
        { key: 'atom', label: 'RSS reader', ext: '.xml', value: urls.atom },
      ] as const).map(({ key, label, ext, value }) => (
        <div key={key} className="space-y-1">
          <label className="text-xs uppercase tracking-wide text-text-muted">
            {label} <span className="font-mono normal-case text-text-primary">{ext}</span>
          </label>
          <div className="flex gap-2">
            <input
              readOnly
              value={value}
              onFocus={e => e.currentTarget.select()}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-bg-primary border border-border text-sm font-mono text-text-primary"
            />
            <button
              onClick={() => copy(key, value)}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-bg-primary shrink-0"
            >
              {copied === key ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ))}

      <div className="flex flex-wrap gap-2 pt-2">
        {confirmingRotate ? (
          <>
            <button
              onClick={() => call('POST')}
              disabled={busy}
              className="px-3 py-2 rounded-lg bg-red-500/90 text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Rotating…' : 'Yes, break existing subscriptions'}
            </button>
            <button
              onClick={() => setConfirmingRotate(false)}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-bg-primary"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setConfirmingRotate(true)}
              disabled={busy}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-bg-primary disabled:opacity-50"
            >
              Rotate links
            </button>
            <button
              onClick={() => call('DELETE')}
              disabled={busy}
              className="px-3 py-2 rounded-lg border border-border text-sm text-text-muted hover:bg-bg-primary disabled:opacity-50"
            >
              Turn off
            </button>
          </>
        )}
      </div>
    </div>
  );
}
