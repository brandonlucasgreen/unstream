import { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { sources } from '../services/sources';
import { SkeletonScreen } from './Skeleton';
import { StatTilesSkeleton } from './LoadingSkeletons';
import { describeActivity, describeDay, type ActivityItem } from '../utils/artistActivity';
import type { SourceId } from '../types';

// The body of /analytics/:slug: the totals for a period, then everything that happened in the last
// 30 days as a list (GET /api/analytics/stats, api/functions/artist-activity.ts).
//
// The list carries the page. Most claimed artists see single-digit numbers in a month, and a few
// totals can say that without the whole page being a dashboard of zeros; listed one by one, the
// same numbers read as things that happened (Brandon, 2026-11-08). No locations, on purpose.

type Period = '7d' | '30d' | '90d' | 'all';

export interface AnalyticsData {
  artistName: string;
  period: string;
  totals: {
    searches: number;
    streaming: number;
    views: number;
    clicks: number;
    releaseViews: number;
  };
  fans: { saved: number; supported: number };
  clicksByPlatform: Record<string, number>;
  releaseViews: Array<{ title: string; slug: string; views: number }>;
  activity: ActivityItem[];
}

const PERIOD_LABELS: Record<Period, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  'all': 'All time',
};

const platformName = (id: string) => sources[id as SourceId]?.name ?? (id === 'tip' ? 'tip page' : id);

export function ArtistAnalytics({ slug, onLoaded }: { slug: string; onLoaded?: (data: AnalyticsData) => void }) {
  const { session } = useAuth();
  const [period, setPeriod] = useState<Period>('30d');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/analytics/stats?slug=${encodeURIComponent(slug)}&period=${period}`, {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    })
      .then(res => {
        if (!res.ok) throw new Error(`analytics stats failed: ${res.status}`);
        return res.json() as Promise<AnalyticsData>;
      })
      .then(result => {
        if (cancelled) return;
        setData(result);
        onLoaded?.(result);
      })
      .catch(e => {
        if (cancelled) return;
        Sentry.captureException(e, { extra: { context: 'artistAnalytics.load', slug } });
        setError("Couldn't load your analytics. Try refreshing.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // onLoaded is a reporter, not an input; re-fetching when its identity changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, period, session?.access_token]);

  const maxClicks = data ? Math.max(...Object.values(data.clicksByPlatform), 1) : 1;

  // Days in order, items in the order the server sent within each.
  const days: Array<{ day: string; items: ActivityItem[] }> = [];
  for (const item of data?.activity ?? []) {
    const last = days[days.length - 1];
    if (last?.day === item.day) last.items.push(item);
    else days.push({ day: item.day, items: [item] });
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Totals</h2>
          <select
            value={period}
            onChange={e => setPeriod(e.target.value as Period)}
            aria-label="Analytics period"
            className="text-sm px-2 py-1 rounded bg-bg-primary border border-border text-text-primary focus:outline-none focus:border-accent-primary"
          >
            {Object.entries(PERIOD_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {error && <p className="text-sm text-error">{error}</p>}

        {loading && !data && (
          <SkeletonScreen label="Loading analytics">
            <StatTilesSkeleton />
          </SkeletonScreen>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <StatTile value={data.totals.searches} label="Searches" />
              <StatTile value={data.totals.streaming} label="Heard while streaming" />
              <StatTile value={data.totals.views} label="Page views" />
              <StatTile value={data.totals.releaseViews} label="Release page views" />
              <StatTile value={data.totals.clicks} label="Link clicks" />
              <StatTile value={data.fans.saved} label="Fans who saved you" />
            </div>
            <p className="text-xs text-text-muted">
              “Heard while streaming” counts fans who were listening to you on a streaming service
              with Unstream's browser extension or app open.
            </p>

            {Object.keys(data.clicksByPlatform).length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium text-text-muted">Clicks by platform</h3>
                {Object.entries(data.clicksByPlatform)
                  .sort(([, a], [, b]) => b - a)
                  .map(([platform, count]) => (
                    <div key={platform} className="flex items-center gap-2 text-sm">
                      <span className="w-24 text-text-muted truncate">{platformName(platform)}</span>
                      <div className="flex-1 h-4 rounded bg-bg-secondary overflow-hidden">
                        <div className="h-full rounded bg-accent-primary/30" style={{ width: `${(count / maxClicks) * 100}%` }} />
                      </div>
                      <span className="w-8 text-right text-text-primary font-medium">{count}</span>
                    </div>
                  ))}
              </div>
            )}

            {data.releaseViews.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium text-text-muted">Most viewed releases</h3>
                <ul className="divide-y divide-border text-sm">
                  {data.releaseViews.map(release => (
                    <li key={release.slug} className="py-2 flex items-center justify-between gap-4">
                      {/* A plain <a>: release pages are rendered by an edge function, and the SPA
                          has no route for a two-segment /a/ path. */}
                      <a href={`/a/${encodeURIComponent(slug)}/${encodeURIComponent(release.slug)}`} className="truncate hover:underline">
                        {release.title}
                      </a>
                      <span className="shrink-0 text-text-muted">{release.views} {release.views === 1 ? 'view' : 'views'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {data && (
        <section className="space-y-4" aria-labelledby="activity-heading">
          <div>
            <h2 id="activity-heading" className="text-lg font-semibold">Activity</h2>
            <p className="text-sm text-text-muted">The last 30 days. Fans are never named.</p>
          </div>
          {days.length === 0 ? (
            <div className="text-center py-10 rounded-lg border border-border border-dashed">
              <p className="text-text-muted">Nothing yet in the last 30 days.</p>
              <p className="text-text-muted text-sm mt-1">
                Saves, views, clicks and tips will show up here as they happen.
              </p>
            </div>
          ) : (
            <ol className="space-y-5">
              {days.map(({ day, items }) => (
                <li key={day}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">{describeDay(day)}</h3>
                  <ul className="space-y-1.5">
                    {items.map(item => (
                      <li
                        key={`${item.kind}|${item.release ?? ''}`}
                        className="text-sm p-3 rounded-lg bg-bg-secondary border border-border"
                      >
                        {describeActivity(item, platformName)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <div className="text-center p-3 rounded-lg bg-bg-secondary border border-border">
      <div className="text-xl font-bold text-text-primary">{value}</div>
      <div className="text-xs text-text-muted">{label}</div>
    </div>
  );
}
