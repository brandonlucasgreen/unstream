import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { CollectionGrid } from './CollectionGrid';

// The owner's view of their collection on /collection (Support Loop Step 3).
// The public page (/u/:handle) shows only purchased, non-hidden items; here the owner
// sees everything, including hidden items (marked), and can hide/unhide each one.
//
// No heading of its own: /collection is titled "My Collection" and a second "Your Collection"
// under it would be the same words twice. The empty state points at the Bandcamp connect panel
// further down the same page — that's the action that fills this in, and it used to send people
// to /settings to find it.

interface CollectionItem {
  id: string;
  source: string;
  title: string;
  artist_name: string;
  art_url: string | null;
  acquired_at: string | null;
  provenance: string;
  hidden: boolean;
  release_id: string | null;
  url: string | null;
  artist_url: string | null;
}

export function CollectionSection() {
  const { session } = useAuth();
  const [items, setItems] = useState<CollectionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchCollection = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch('/api/me/collection', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error('Failed to load collection');
      const data = await res.json();
      setItems(data.items || []);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'CollectionSection.fetch' } });
      setError('Failed to load your collection.');
    }
  }, [session]);

  useEffect(() => {
    fetchCollection();
  }, [fetchCollection]);

  const handleToggleHidden = async (item: CollectionItem) => {
    if (!session || togglingId) return;
    setTogglingId(item.id);
    setError(null);
    try {
      const res = await fetch('/api/me/collection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ id: item.id, hidden: !item.hidden }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update item');
      }
      const updated = await res.json();
      setItems(prev => prev ? prev.map(i => (i.id === updated.id ? { ...i, hidden: updated.hidden } : i)) : prev);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'CollectionSection.toggleHidden' } });
      setError(e instanceof Error ? e.message : 'Failed to update item.');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <section>
      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {items === null ? (
        !error && <p className="text-sm text-text-muted">Loading your collection…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-12 rounded-lg border border-border border-dashed">
          <p className="text-text-muted">No releases in your collection yet.</p>
          <p className="text-text-muted text-sm mt-1">
            Bought music on Bandcamp?{' '}
            <a href="#bandcamp-connect" className="text-accent-primary hover:underline">
              Connect your collection below
            </a>{' '}
            and it fills in from what you've actually bought.
          </p>
        </div>
      ) : (
        <CollectionGrid
          items={items.map(item => ({
            key: item.id,
            title: item.title,
            artistName: item.artist_name,
            artUrl: item.art_url,
            acquiredAt: item.acquired_at,
            releaseUrl: item.url,
            artistUrl: item.artist_url,
            dimmed: item.hidden,
            overlay: (
              <button
                type="button"
                onClick={() => handleToggleHidden(item)}
                disabled={togglingId === item.id}
                aria-label={item.hidden ? `Show ${item.title} on your public page` : `Hide ${item.title} from your public page`}
                title={item.hidden ? 'Hidden from your public page — click to show' : 'Hide from your public page'}
                className={`absolute top-1.5 right-1.5 p-1.5 rounded-md bg-black/60 text-white transition-opacity disabled:opacity-50 ${
                  item.hidden ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                }`}
              >
                {item.hidden ? (
                  <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            ),
          }))}
        />
      )}
    </section>
  );
}
