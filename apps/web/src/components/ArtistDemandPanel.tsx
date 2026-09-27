import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { getDashboardInterest, type InterestCounts } from '../services/artistInterest';

// The artist dashboard's demand panel (docs/specs/artist-patronage-spec.md §8.1): how many fans
// would tip, and where they'd come to a show. Always shown, before and after tips are set up.
// Unlike the public artist page, these counts have no threshold — they're the artist's own.

export function ArtistDemandPanel({ slug }: { slug: string }) {
  const { session } = useAuth();
  const [counts, setCounts] = useState<InterestCounts | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    getDashboardInterest(session.access_token, slug, controller.signal)
      .then(setCounts)
      .catch(err => {
        if (controller.signal.aborted) return;
        Sentry.captureException(err, { extra: { context: 'ArtistDemandPanel.load', slug } });
        setFailed(true);
      });
    return () => controller.abort();
  }, [session, slug]);

  return (
    <div className="mt-4 pt-4 border-t border-border/50">
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">Demand</h3>
      {failed ? (
        <p className="text-sm text-text-muted">Couldn't load demand right now. Try refreshing.</p>
      ) : counts === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-2xl font-semibold">{counts.tipCount}</p>
            <p className="text-sm text-text-secondary">
              {counts.tipCount === 1 ? 'fan wants' : 'fans want'} to tip you
            </p>
          </div>
          <div>
            <p className="text-sm font-medium mb-1">Play my city</p>
            {counts.cities.length === 0 ? (
              <p className="text-sm text-text-muted">No cities yet. Fans can ask from your artist page.</p>
            ) : (
              <ol className="text-sm space-y-0.5">
                {counts.cities.map(c => (
                  <li key={c.label} className="flex justify-between gap-4">
                    <span className="truncate">{c.label}</span>
                    <span className="text-text-muted tabular-nums">{c.count}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
