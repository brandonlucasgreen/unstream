import { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { sources } from '../services/sources';
import { SkeletonScreen } from './Skeleton';
import { StatTilesSkeleton } from './LoadingSkeletons';
import type { SourceId } from '../types';

type Period = '7d' | '30d' | '90d' | 'all';

interface AnalyticsData {
  period: string;
  totals: {
    searches: number;
    views: number;
    clicks: number;
  };
  clicksByPlatform: Record<string, number>;
}

const PERIOD_LABELS: Record<Period, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  'all': 'All time',
};

export function ArtistAnalytics({ slug }: { slug: string }) {
  const { session } = useAuth();
  const [period, setPeriod] = useState<Period>('30d');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;

    setLoading(true);
    setError(null);

    fetch(`/api/analytics/stats?slug=${encodeURIComponent(slug)}&period=${period}`, {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to load');
        return res.json();
      })
      .then(setData)
      .catch(e => { Sentry.captureException(e, { extra: { context: 'artistDashboard.analytics' } }); setError('Unable to load analytics') })
      .finally(() => setLoading(false));
  }, [slug, period, session?.access_token]);

  const maxClicks = data ? Math.max(...Object.values(data.clicksByPlatform), 1) : 1;

  return (
    <div className="mt-4 pt-4 border-t border-border/50">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-muted">Analytics</h3>
        <select
          value={period}
          onChange={e => setPeriod(e.target.value as Period)}
          className="text-xs px-2 py-1 rounded bg-bg-primary border border-border text-text-primary focus:outline-none focus:border-accent-primary"
        >
          {Object.entries(PERIOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {loading && (
        <SkeletonScreen label="Loading analytics">
          <StatTilesSkeleton />
        </SkeletonScreen>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {data && !loading && (
        <div className="space-y-3">
          {/* Stat cards */}
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center p-2 rounded bg-bg-primary border border-border/50">
              <div className="text-lg font-bold text-text-primary">{data.totals.searches}</div>
              <div className="text-xs text-text-muted">Searches</div>
            </div>
            <div className="text-center p-2 rounded bg-bg-primary border border-border/50">
              <div className="text-lg font-bold text-text-primary">{data.totals.views}</div>
              <div className="text-xs text-text-muted">Page views</div>
            </div>
            <div className="text-center p-2 rounded bg-bg-primary border border-border/50">
              <div className="text-lg font-bold text-text-primary">{data.totals.clicks}</div>
              <div className="text-xs text-text-muted">Link clicks</div>
            </div>
          </div>

          {/* Platform click breakdown */}
          {Object.keys(data.clicksByPlatform).length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-text-muted">Clicks by platform</p>
              {Object.entries(data.clicksByPlatform)
                .sort(([, a], [, b]) => b - a)
                .map(([platform, count]) => (
                  <div key={platform} className="flex items-center gap-2 text-xs">
                    <span className="w-20 text-text-muted truncate">{sources[platform as SourceId]?.name || platform}</span>
                    <div className="flex-1 h-4 rounded bg-bg-primary overflow-hidden">
                      <div
                        className="h-full rounded bg-accent-primary/30"
                        style={{ width: `${(count / maxClicks) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-text-primary font-medium">{count}</span>
                  </div>
                ))}
            </div>
          )}

          {data.totals.searches === 0 && data.totals.views === 0 && data.totals.clicks === 0 && (
            <p className="text-xs text-text-muted text-center py-2">
              No activity yet for this period.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
