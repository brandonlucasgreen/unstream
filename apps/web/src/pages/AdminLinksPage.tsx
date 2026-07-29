import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';

interface LinkSuppression {
  id: string;
  url: string;
  source_id: string | null;
  artist_name: string | null;
  artist_name_norm: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

/**
 * Admin review of removed platform links, with undo.
 *
 * Removals happen inline on search results (the ✕ next to each platform badge);
 * this page exists so they can be audited and reversed.
 */
export function AdminLinksPage() {
  const { isAdmin, session } = useAuth();
  const navigate = useNavigate();
  const [suppressions, setSuppressions] = useState<LinkSuppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const fetchSuppressions = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/link-suppression', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });
      if (!response.ok) throw new Error(`Failed to load (${response.status})`);
      const data = await response.json();
      setSuppressions(data.suppressions || []);
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'admin.linkSuppressions.list' } });
      setError(err instanceof Error ? err.message : 'Failed to load removed links.');
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (isAdmin) fetchSuppressions();
  }, [isAdmin, fetchSuppressions]);

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/link-suppression?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${session?.access_token}` },
      });
      if (!response.ok) throw new Error(`Failed to restore (${response.status})`);
      setSuppressions(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'admin.linkSuppressions.restore' } });
      setError(err instanceof Error ? err.message : 'Failed to restore link.');
    } finally {
      setRestoringId(null);
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-text-muted">Not authorized.</p>
        <button onClick={() => navigate('/')} className="text-accent-primary hover:underline">
          Back to search
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-text-primary">Removed Links</h1>
          <p className="text-text-secondary text-sm mt-1">
            Platform links hidden from search results. Restore one and it comes back on the next
            uncached search.
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-text-muted text-sm">Loading...</p>
        ) : suppressions.length === 0 ? (
          <p className="text-text-muted text-sm">
            No links have been removed yet. Use the ✕ next to a platform badge on a search result.
          </p>
        ) : (
          <div className="space-y-3">
            {suppressions.map(s => (
              <div
                key={s.id}
                className="p-4 rounded-lg bg-surface border border-border space-y-2"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <p className="text-sm text-text-primary">
                      {s.source_id ? `${s.source_id} — ` : ''}
                      {s.artist_name_norm === null ? 'all artists' : s.artist_name}
                    </p>
                    <p className="text-xs text-text-muted break-all">{s.url}</p>
                    {s.reason && <p className="text-xs text-text-secondary">{s.reason}</p>}
                    <p className="text-xs text-text-muted">
                      {new Date(s.created_at).toLocaleString()}
                      {s.created_by ? ` · ${s.created_by}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRestore(s.id)}
                    disabled={restoringId === s.id}
                    className="px-3 py-1.5 rounded-lg bg-surface-secondary border border-border text-sm text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    {restoringId === s.id ? 'Restoring...' : 'Restore'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
