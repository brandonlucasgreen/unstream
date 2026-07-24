import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { Skeleton } from '../components/Skeleton';
import { PageSkeleton } from '../components/PageSkeleton';
import { StatTilesSkeleton } from '../components/LoadingSkeletons';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DailyStat {
  date: string;
  searches: number;
  clicks: number;
  activations: number;
}

interface AppStat {
  app: string;
  searches: number;
  clicks: number;
}

interface PlatformStat {
  platform: string;
  clicks: number;
}

interface StreamingStat {
  service: string;
  activations: number;
}

interface RecentEvent {
  event_type: string;
  app: string;
  context: Record<string, unknown>;
  created_at: string;
}

interface DashboardData {
  summary: {
    searches_today: number;
    searches_7d: number;
    searches_30d: number;
    success_rate_7d: number | null;
    top_platform: string | null;
    top_streaming_service: string | null;
  };
  daily: DailyStat[];
  by_app: AppStat[];
  platforms: PlatformStat[];
  streaming_services: StreamingStat[];
  recent: RecentEvent[];
}

// ─── Bar chart ───────────────────────────────────────────────────────────────

function BarChart({ data }: { data: DailyStat[] }) {
  const maxVal = Math.max(...data.map(d => d.searches + d.clicks), 1);
  const width = 780;
  const height = 160;
  const padLeft = 36;
  const padBottom = 28;
  const chartW = width - padLeft - 8;
  const chartH = height - padBottom - 8;
  const barW = Math.floor(chartW / data.length) - 2;

  // Y-axis ticks
  const ticks = [0, Math.round(maxVal / 2), maxVal];

  // Format date labels: show day-of-month, highlight first of month
  const formatLabel = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.getDate() === 1
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : String(d.getDate());
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height: `${height}px` }}
      aria-label="30-day event chart"
    >
      {/* Y-axis grid lines */}
      {ticks.map(tick => {
        const y = 8 + chartH - (tick / maxVal) * chartH;
        return (
          <g key={tick}>
            <line
              x1={padLeft}
              x2={width - 8}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.1}
              strokeWidth={1}
            />
            <text
              x={padLeft - 4}
              y={y + 4}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              opacity={0.4}
            >
              {tick}
            </text>
          </g>
        );
      })}

      {/* Bars */}
      {data.map((d, i) => {
        const x = padLeft + i * (chartW / data.length) + 1;
        const searchH = (d.searches / maxVal) * chartH;
        const clickH = (d.clicks / maxVal) * chartH;
        const activationH = (d.activations / maxVal) * chartH;
        const totalH = searchH + clickH + activationH;
        const barY = 8 + chartH - totalH;

        // Show date label every ~5 days or first of month
        const date = new Date(d.date + 'T00:00:00');
        const showLabel = i === 0 || i === data.length - 1 || date.getDate() === 1 || i % 5 === 0;

        return (
          <g key={d.date}>
            {/* Activation segment (bottom) */}
            {activationH > 0 && (
              <rect
                x={x}
                y={8 + chartH - activationH}
                width={barW}
                height={activationH}
                rx={1}
                fill="var(--color-accent-secondary, #8b5cf6)"
                opacity={0.5}
              />
            )}
            {/* Click segment */}
            {clickH > 0 && (
              <rect
                x={x}
                y={8 + chartH - activationH - clickH}
                width={barW}
                height={clickH}
                fill="var(--color-accent-primary, #22d3ee)"
                opacity={0.6}
              />
            )}
            {/* Search segment (top) */}
            {searchH > 0 && (
              <rect
                x={x}
                y={barY}
                width={barW}
                height={searchH}
                rx={1}
                fill="var(--color-accent-primary, #22d3ee)"
                opacity={0.9}
              />
            )}
            {/* X-axis label */}
            {showLabel && (
              <text
                x={x + barW / 2}
                y={height - 4}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                opacity={0.4}
              >
                {formatLabel(d.date)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Metric card ─────────────────────────────────────────────────────────────

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-surface-secondary rounded-xl p-4 border border-border">
      <p className="text-text-muted text-xs font-medium uppercase tracking-wide mb-1">{label}</p>
      <p className="text-text-primary text-2xl font-semibold font-display">{value}</p>
      {sub && <p className="text-text-muted text-xs mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Table ───────────────────────────────────────────────────────────────────

function DataTable<T extends Record<string, unknown>>({
  rows,
  columns,
  emptyLabel = 'No data yet',
}: {
  rows: T[];
  columns: { key: keyof T; label: string; align?: 'left' | 'right' }[];
  emptyLabel?: string;
}) {
  if (rows.length === 0) {
    return <p className="text-text-muted text-sm py-4 text-center">{emptyLabel}</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          {columns.map(col => (
            <th
              key={String(col.key)}
              className={`pb-2 text-text-muted font-medium text-xs uppercase tracking-wide ${col.align === 'right' ? 'text-right' : 'text-left'}`}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-border/40 last:border-0">
            {columns.map(col => (
              <td
                key={String(col.key)}
                className={`py-2 text-text-secondary ${col.align === 'right' ? 'text-right tabular-nums' : ''}`}
              >
                {String(row[col.key] ?? '—')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function formatEventType(t: string) {
  return t.replace(/_/g, ' ');
}

function formatRelativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function AdminAnalyticsPage() {
  const { isAdmin, isLoading: authLoading, session } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Analytics - Unstream Admin';
    return () => { document.title = 'Unstream - Support Artists Directly'; };
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      navigate('/');
      return;
    }

    fetch('/api/analytics/dashboard', {
      headers: { Authorization: `Bearer ${session?.access_token}` },
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: DashboardData) => setData(d))
      .catch(e => { Sentry.captureException(e, { extra: { context: 'admin.analyticsDashboard' } }); setError(e.message) })
      .finally(() => setLoading(false));
  }, [authLoading, isAdmin, session, navigate]);

  if (authLoading || loading) {
    return (
      <PageSkeleton label="Loading analytics" maxWidth="max-w-5xl">
        <div className="space-y-8">
          <Skeleton className="h-7 w-40" />
          <StatTilesSkeleton bars={5} />
          <Skeleton className="h-56 w-full rounded-lg" />
          <StatTilesSkeleton bars={4} />
        </div>
      </PageSkeleton>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-red-500 text-sm">Failed to load analytics: {error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { summary, daily, by_app, platforms, streaming_services, recent } = data;

  const appRows = by_app.map(a => ({
    app: a.app,
    searches: a.searches,
    clicks: a.clicks,
    total: a.searches + a.clicks,
  }));

  const recentRows = recent.map(e => ({
    type: formatEventType(e.event_type),
    app: e.app,
    detail: Object.entries(e.context)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ') || '—',
    when: formatRelativeTime(e.created_at),
  }));

  return (
    <div className="min-h-screen">
      <Header />

      <div className="pt-6 pb-4 px-4">
        <div className="max-w-5xl mx-auto">
          <h1 className="font-display text-2xl font-semibold text-text-primary">Analytics</h1>
          <p className="text-text-muted text-sm mt-1">Last 30 days · anonymized · no PII stored</p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-5xl mx-auto space-y-8">

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label="Searches today" value={summary.searches_today.toLocaleString()} />
            <MetricCard label="Searches 7d" value={summary.searches_7d.toLocaleString()} />
            <MetricCard label="Searches 30d" value={summary.searches_30d.toLocaleString()} />
            <MetricCard
              label="Success rate 7d"
              value={summary.success_rate_7d !== null ? `${summary.success_rate_7d}%` : '—'}
              sub="searches with results"
            />
            <MetricCard
              label="Top platform"
              value={summary.top_platform ?? '—'}
            />
            <MetricCard
              label="Top streaming"
              value={summary.top_streaming_service ?? '—'}
            />
          </div>

          {/* 30-day chart */}
          <div className="bg-surface-secondary rounded-xl border border-border p-5">
            <div className="flex items-center gap-4 mb-4">
              <h2 className="font-display text-sm font-semibold text-text-primary">30-day volume</h2>
              <div className="flex items-center gap-3 text-xs text-text-muted ml-auto">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: 'var(--color-accent-primary, #22d3ee)', opacity: 0.9 }} />
                  Searches
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: 'var(--color-accent-primary, #22d3ee)', opacity: 0.6 }} />
                  Clicks
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: 'var(--color-accent-secondary, #8b5cf6)', opacity: 0.5 }} />
                  Extension activations
                </span>
              </div>
            </div>
            <div className="text-text-primary">
              {daily.length > 0
                ? <BarChart data={daily} />
                : <p className="text-text-muted text-sm py-8 text-center">No data yet — events will appear once users start using the app.</p>
              }
            </div>
          </div>

          {/* Bottom tables */}
          <div className="grid md:grid-cols-2 gap-6">

            {/* Platform breakdown */}
            <div className="bg-surface-secondary rounded-xl border border-border p-5">
              <h2 className="font-display text-sm font-semibold text-text-primary mb-4">Platform clicks (30d)</h2>
              <DataTable
                rows={platforms as unknown as Record<string, unknown>[]}
                columns={[
                  { key: 'platform', label: 'Platform' },
                  { key: 'clicks', label: 'Clicks', align: 'right' },
                ]}
                emptyLabel="No click data yet"
              />
            </div>

            {/* By app */}
            <div className="bg-surface-secondary rounded-xl border border-border p-5">
              <h2 className="font-display text-sm font-semibold text-text-primary mb-4">By app (30d)</h2>
              <DataTable
                rows={appRows as unknown as Record<string, unknown>[]}
                columns={[
                  { key: 'app', label: 'App' },
                  { key: 'searches', label: 'Searches', align: 'right' },
                  { key: 'clicks', label: 'Clicks', align: 'right' },
                ]}
                emptyLabel="No app data yet"
              />
            </div>

            {/* Streaming services */}
            <div className="bg-surface-secondary rounded-xl border border-border p-5">
              <h2 className="font-display text-sm font-semibold text-text-primary mb-4">Extension: streaming services (30d)</h2>
              <DataTable
                rows={streaming_services as unknown as Record<string, unknown>[]}
                columns={[
                  { key: 'service', label: 'Service' },
                  { key: 'activations', label: 'Activations', align: 'right' },
                ]}
                emptyLabel="No extension activations yet"
              />
            </div>

            {/* Recent events */}
            <div className="bg-surface-secondary rounded-xl border border-border p-5">
              <h2 className="font-display text-sm font-semibold text-text-primary mb-4">Recent events</h2>
              <DataTable
                rows={recentRows as unknown as Record<string, unknown>[]}
                columns={[
                  { key: 'type', label: 'Event' },
                  { key: 'app', label: 'App' },
                  { key: 'detail', label: 'Detail' },
                  { key: 'when', label: 'When', align: 'right' },
                ]}
                emptyLabel="No events yet"
              />
            </div>
          </div>

        </div>
      </main>

      <Footer />
    </div>
  );
}
