import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

interface SharingState {
  public: boolean;
  public_handle: string | null;
  public_url: string | null;
}

export function SharingControls() {
  const { session } = useAuth();
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchSharing = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/me/saved-artists-sharing', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      if (res.status === 404) {
        // No username set — sharing unavailable
        setSharing(null);
        return;
      }
      if (res.status === 429) {
        setError(RATE_LIMIT_MESSAGE);
        return;
      }
      if (!res.ok) throw new Error('Failed to fetch sharing status');
      const data = await res.json();
      setSharing(data);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'SharingControls.fetchSharing' } });
      setError('Failed to load sharing status.');
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    fetchSharing();
  }, [fetchSharing]);

  const handleToggle = async (makePublic: boolean) => {
    if (!session) return;
    setToggling(true);
    setError(null);
    try {
      const res = await fetch('/api/me/saved-artists-sharing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ public: makePublic }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update sharing');
      }
      const data = await res.json();
      setSharing(data);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'SharingControls.toggle' } });
      setError(e instanceof Error ? e.message : 'Failed to update sharing.');
    } finally {
      setToggling(false);
    }
  };

  const handleCopy = async () => {
    if (!sharing?.public_url) return;
    try {
      await navigator.clipboard.writeText(sharing.public_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-secure contexts
      const textarea = document.createElement('textarea');
      textarea.value = sharing.public_url;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-border p-4 bg-bg-secondary">
        <p className="text-sm text-text-muted">Loading sharing settings…</p>
      </div>
    );
  }

  // State 1: No username set — link to /settings
  if (!sharing) {
    return (
      <div className="rounded-lg border border-border p-4 bg-bg-secondary">
        <p className="text-sm text-text-primary">
          Set a username to publish your public profile.
        </p>
        <Link
          to="/settings"
          className="inline-block mt-2 px-3 py-1.5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
        >
          Set username
        </Link>
      </div>
    );
  }

  // State 2: Private (sharing off)
  if (!sharing.public) {
    return (
      <div className="rounded-lg border border-border p-4 bg-bg-secondary">
        <p className="text-sm text-text-primary">Your profile is private.</p>
        <p className="text-xs text-text-muted mt-1">
          Making it public publishes your username, the releases in your collection, the artists
          you've saved, and your location if you've set one, at a link anyone can open and search
          engines can index. Hidden items stay private, and your email address is never published.
          See the{' '}
          <Link to="/terms#section-6" className="text-accent-primary hover:underline">Terms of Use</Link>.
        </p>
        {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
        <button
          onClick={() => handleToggle(true)}
          disabled={toggling}
          className="mt-2 px-3 py-1.5 rounded-lg bg-accent-secondary text-white text-sm font-medium hover:bg-accent-secondary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {toggling ? 'Enabling…' : 'Make public'}
        </button>
      </div>
    );
  }

  // State 3: Public (sharing on)
  return (
    <div className="rounded-lg border border-border p-4 bg-bg-secondary">
      <p className="text-sm text-text-primary">Your profile is public.</p>
      <p className="text-xs text-text-muted mt-1">
        Anyone with the link can see the releases in your collection and the artists you've
        saved. Items you've hidden stay private.
      </p>
      {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className="text-sm text-text-muted font-mono truncate max-w-xs">
          {sharing.public_url}
        </span>
        <a
          href={sharing.public_url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm font-medium hover:text-text-primary hover:border-border-hover transition-colors"
        >
          View profile
        </a>
        <button
          onClick={handleCopy}
          className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${
            copied
              ? 'border-green-500/30 text-green-400'
              : 'border-border text-text-muted hover:text-text-primary hover:border-border-hover'
          }`}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <button
          onClick={() => handleToggle(false)}
          disabled={toggling}
          className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-red-400 hover:border-red-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {toggling ? 'Disabling…' : 'Make private'}
        </button>
      </div>
    </div>
  );
}