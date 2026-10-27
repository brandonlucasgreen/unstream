import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { Skeleton } from '../components/Skeleton';
import { PageSkeleton } from '../components/PageSkeleton';
import { StatTilesSkeleton } from '../components/LoadingSkeletons';
import { DEFAULT_PAGE_TITLE } from '../data/seo';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChartBucket {
  date: string;
  searches: number;
  clicks: number;
  activations: number;
}

interface ClientStat {
  app: string;
  /** 'chrome' | 'firefox' | 'unrecorded' for the extension, null for the other apps. */
  browser: string | null;
  searches: number;
  clicks: number;
}

interface SearchKindStat {
  app: string;
  typed: number;
  now_playing: number;
  unlabelled: number;
}

interface DashboardData {
  range: { from: string; to: string; days: number; granularity: 'day' | 'week' };
  summary: {
    searches: number;
    searches_per_day: number;
    success_rate: number | null;
    top_platform: string | null;
    top_streaming_service: string | null;
  };
  chart: ChartBucket[];
  clients: ClientStat[];
  search_kinds: SearchKindStat[];
  platforms: { platform: string; clicks: number }[];
  streaming_services: { service: string; activations: number }[];
}

type TrafficData =
  | { configured: false }
  | {
      configured: true;
      visitors: number;
      chart: { date: string; visitors: number }[];
      top_pages: { path: string; title: string; visitors: number }[];
      top_referrers: { name: string; visitors: number }[];
    };

// ─── Date range ──────────────────────────────────────────────────────────────

const PRESETS = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '12m', label: '12 months', days: 365 },
] as const;
const DEFAULT_PRESET = '30d';

const DAY_MS = 24 * 60 * 60 * 1000;

// Days are UTC throughout, matching the server (api/functions/analytics-range.ts).
function utcDate(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The range in the URL: `?range=90d` for a preset, `?from=…&to=…` for a custom range. Kept in
 * the URL so a range survives a reload and can be bookmarked.
 */
function rangeFromParams(params: URLSearchParams): { preset: string | null; from: string; to: string } {
  const from = params.get('from');
  const to = params.get('to');
  if (from && to) return { preset: null, from, to };
  const preset = PRESETS.find(p => p.id === params.get('range')) ?? PRESETS.find(p => p.id === DEFAULT_PRESET)!;
  return { preset: preset.id, from: utcDate(-(preset.days - 1)), to: utcDate() };
}

function formatDay(date: string, withYear = false): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

function RangePicker({ preset, from, to }: { preset: string | null; from: string; to: string }) {
  const [, setParams] = useSearchParams();
  const [customOpen, setCustomOpen] = useState(preset === null);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  const buttonClass = (active: boolean) =>
    `min-h-9 px-3 rounded-lg border text-sm font-medium transition-colors ${
      active ? 'border-accent-primary bg-accent-primary/10 text-link' : 'border-border hover:bg-bg-hover text-text-secondary'
    }`;
  const inputClass =
    'px-2 py-1.5 rounded-lg bg-bg-secondary border border-border/50 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/50';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map(p => (
        <button
          key={p.id}
          type="button"
          aria-pressed={preset === p.id}
          onClick={() => { setCustomOpen(false); setParams({ range: p.id }); }}
          className={buttonClass(preset === p.id)}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={customOpen}
        onClick={() => setCustomOpen(true)}
        className={buttonClass(customOpen)}
      >
        Custom
      </button>
      {customOpen && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={e => {
            e.preventDefault();
            if (draftFrom && draftTo && draftFrom <= draftTo) setParams({ from: draftFrom, to: draftTo });
          }}
        >
          <label className="sr-only" htmlFor="analytics-from">From</label>
          <input id="analytics-from" type="date" value={draftFrom} max={draftTo} onChange={e => setDraftFrom(e.target.value)} className={inputClass} />
          <span className="text-text-muted text-sm">to</span>
          <label className="sr-only" htmlFor="analytics-to">To</label>
          <input id="analytics-to" type="date" value={draftTo} min={draftFrom} max={utcDate()} onChange={e => setDraftTo(e.target.value)} className={inputClass} />
          <button type="submit" className={buttonClass(false)} disabled={!draftFrom || !draftTo || draftFrom > draftTo}>
            Apply
          </button>
        </form>
      )}
    </div>
  );
}

// ─── Bar chart ───────────────────────────────────────────────────────────────

interface Series<T> {
  key: keyof T & string;
  label: string;
  color: string;
  opacity: number;
}

const SEARCH_SERIES: Series<ChartBucket>[] = [
  // Drawn bottom to top.
  { key: 'activations', label: 'Extension activations', color: 'var(--color-accent-secondary, #8b5cf6)', opacity: 0.5 },
  { key: 'clicks', label: 'Clicks', color: 'var(--color-accent-primary, #22d3ee)', opacity: 0.6 },
  { key: 'searches', label: 'Searches', color: 'var(--color-accent-primary, #22d3ee)', opacity: 0.9 },
];

const VISITOR_SERIES: Series<{ date: string; visitors: number }>[] = [
  { key: 'visitors', label: 'Visitors', color: 'var(--color-accent-secondary, #8b5cf6)', opacity: 0.7 },
];

function Legend<T>({ series }: { series: Series<T>[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
      {[...series].reverse().map(s => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: s.color, opacity: s.opacity }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Stacked bars, one per day or week. */
function BarChart<T extends { date: string }>({ data, series, label }: { data: T[]; series: Series<T>[]; label: string }) {
  const value = (d: T, key: keyof T) => Number(d[key]) || 0;
  const maxVal = Math.max(...data.map(d => series.reduce((n, s) => n + value(d, s.key), 0)), 1);
  const width = 780;
  const height = 160;
  const padLeft = 44;
  const padBottom = 28;
  const chartW = width - padLeft - 8;
  const chartH = height - padBottom - 8;
  const slot = chartW / data.length;
  const barW = Math.max(slot - 2, 1);
  // Room for about eight labels whatever the range.
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  const ticks = [0, Math.round(maxVal / 2), maxVal];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: `${height}px` }} aria-label={label}>
      {ticks.map(tick => {
        const y = 8 + chartH - (tick / maxVal) * chartH;
        return (
          <g key={tick}>
            <line x1={padLeft} x2={width - 8} y1={y} y2={y} stroke="currentColor" strokeOpacity={0.1} strokeWidth={1} />
            <text x={padLeft - 4} y={y + 4} textAnchor="end" fontSize={12} fill="currentColor" opacity={0.4}>
              {tick.toLocaleString()}
            </text>
          </g>
        );
      })}

      {data.map((d, i) => {
        const x = padLeft + i * slot + 1;
        let stacked = 0;
        return (
          <g key={d.date}>
            <title>
              {`${formatDay(d.date)}: ${series.map(s => `${value(d, s.key).toLocaleString()} ${s.label.toLowerCase()}`).join(', ')}`}
            </title>
            {series.map(s => {
              const h = (value(d, s.key) / maxVal) * chartH;
              stacked += h;
              return h > 0 ? (
                <rect key={s.key} x={x} y={8 + chartH - stacked} width={barW} height={h} fill={s.color} opacity={s.opacity} />
              ) : null;
            })}
            {(i % labelEvery === 0 || i === data.length - 1) && (
              <text x={x + barW / 2} y={height - 4} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.4}>
                {formatDay(d.date)}
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
            {columns.map(col => {
              const cell = row[col.key];
              return (
                <td
                  key={String(col.key)}
                  className={`py-2 text-text-secondary ${col.align === 'right' ? 'text-right tabular-nums' : 'break-all'}`}
                >
                  {typeof cell === 'number' ? cell.toLocaleString() : String(cell ?? '—')}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-surface-secondary rounded-xl border border-border p-5">
      <h2 className="font-display text-sm font-semibold text-text-primary mb-4">{title}</h2>
      {children}
    </div>
  );
}

const APP_NAMES: Record<string, string> = { web: 'Web', extension: 'Extension', mac: 'Mac app' };
const BROWSER_NAMES: Record<string, string> = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  unrecorded: 'browser not recorded',
};

function clientName(client: ClientStat): string {
  const app = APP_NAMES[client.app] ?? client.app;
  return client.browser ? `${app} · ${BROWSER_NAMES[client.browser] ?? client.browser}` : app;
}

// ─── Website traffic (GoatCounter) ───────────────────────────────────────────

function TrafficSection({ traffic, error }: { traffic: TrafficData | null; error: string | null }) {
  if (error) {
    return (
      <Panel title="Website traffic">
        <p className="text-error text-sm">Couldn’t load GoatCounter: {error}</p>
      </Panel>
    );
  }
  if (!traffic) return null;
  if (!traffic.configured) {
    return (
      <Panel title="Website traffic">
        <p className="text-text-muted text-sm">
          GoatCounter isn’t connected. Add a GoatCounter API token with the “Read statistics” permission as{' '}
          <code>GOATCOUNTER_API_TOKEN</code> in Netlify to show visitors here.
        </p>
      </Panel>
    );
  }
  return (
    <>
      <div className="bg-surface-secondary rounded-xl border border-border p-5">
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <h2 className="font-display text-sm font-semibold text-text-primary">Website visitors</h2>
          <div className="ml-auto"><Legend series={VISITOR_SERIES} /></div>
        </div>
        <div className="text-text-primary">
          <BarChart data={traffic.chart} series={VISITOR_SERIES} label="Website visitors chart" />
        </div>
        <p className="text-text-muted text-xs mt-3">
          From GoatCounter, which counts unique visitors per page per day rather than pageviews.
        </p>
      </div>
      <div className="grid md:grid-cols-2 gap-6">
        <Panel title="Top pages">
          <DataTable
            rows={traffic.top_pages as unknown as Record<string, unknown>[]}
            columns={[
              { key: 'path', label: 'Page' },
              { key: 'visitors', label: 'Visitors', align: 'right' },
            ]}
            emptyLabel="No pages yet"
          />
        </Panel>
        <Panel title="Top referrers">
          <DataTable
            rows={traffic.top_referrers as unknown as Record<string, unknown>[]}
            columns={[
              { key: 'name', label: 'Referrer' },
              { key: 'visitors', label: 'Visitors', align: 'right' },
            ]}
            emptyLabel="No referrers yet"
          />
        </Panel>
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function AdminAnalyticsPage() {
  const { isAdmin, isLoading: authLoading, session } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { preset, from, to } = rangeFromParams(params);
  // Each answer is stored with the range it answers, so the page knows it's loading a new range
  // (and keeps the last one on screen, dimmed) without resetting state from inside the effect.
  const rangeKey = `${from}:${to}`;
  const [loaded, setLoaded] = useState<{ key: string; data: DashboardData } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [trafficResult, setTrafficResult] = useState<{ traffic: TrafficData | null; error: string | null }>({
    traffic: null,
    error: null,
  });

  useEffect(() => {
    document.title = 'Analytics - Unstream Admin';
    return () => { document.title = DEFAULT_PAGE_TITLE; };
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) {
      navigate('/');
      return;
    }

    // Searches and website traffic load independently: GoatCounter being down or unconfigured
    // must not take the search numbers with it.
    let current = true;
    const query = new URLSearchParams({ from, to });
    const headers = { Authorization: `Bearer ${session?.access_token}` };
    const getJson = async <T,>(path: string): Promise<T> => {
      const res = await fetch(`${path}?${query}`, { headers });
      if (!res.ok) {
        // Both endpoints say why in `error`, and the traffic one passes GoatCounter's reason in `detail`.
        const body = await res.json().catch(() => null) as { error?: string; detail?: string } | null;
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    };

    getJson<DashboardData>('/api/analytics/dashboard')
      .then(d => { if (current) setLoaded({ key: rangeKey, data: d }); })
      .catch(e => {
        Sentry.captureException(e, { extra: { context: 'admin.analyticsDashboard' } });
        if (current) setFailed({ key: rangeKey, message: e.message });
      });

    getJson<TrafficData>('/api/analytics/traffic')
      .then(t => { if (current) setTrafficResult({ traffic: t, error: null }); })
      // The endpoint reports GoatCounter failures to Sentry itself.
      .catch(e => { if (current) setTrafficResult({ traffic: null, error: e.message }); });

    return () => { current = false; };
  }, [authLoading, isAdmin, session, navigate, from, to, rangeKey]);

  const data = loaded?.data ?? null;
  const error = failed?.key === rangeKey ? failed.message : null;
  const loading = loaded?.key !== rangeKey && !error;
  const { traffic, error: trafficError } = trafficResult;

  if (authLoading || (loading && !data)) {
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
        <p className="text-error text-sm">Failed to load analytics: {error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { range, summary, chart, clients, search_kinds, platforms, streaming_services } = data;
  const webSearches = clients.find(c => c.app === 'web')?.searches ?? 0;
  const visitors = traffic?.configured ? traffic.visitors : null;

  const clientRows = clients.map(c => ({ client: clientName(c), searches: c.searches, clicks: c.clicks }));
  const kindRows = search_kinds.map(k => ({ ...k, client: APP_NAMES[k.app] ?? k.app }));

  return (
    <div className="min-h-screen">
      <Header />

      <div className="pt-6 pb-4 px-4">
        <div className="max-w-5xl mx-auto space-y-4">
          <div>
            <h1 className="font-display text-2xl font-semibold text-text-primary">Analytics</h1>
            <p className="text-text-muted text-sm mt-1">
              {formatDay(range.from, true)} – {formatDay(range.to, true)} (UTC) · anonymized · no PII stored
            </p>
          </div>
          <RangePicker key={`${preset}:${from}:${to}`} preset={preset} from={from} to={to} />
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className={`max-w-5xl mx-auto space-y-8 transition-opacity ${loading ? 'opacity-50' : ''}`} aria-busy={loading}>

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard label="Searches" value={summary.searches.toLocaleString()} sub={`${summary.searches_per_day.toLocaleString()} a day`} />
            <MetricCard
              label="Success rate"
              value={summary.success_rate !== null ? `${summary.success_rate}%` : '—'}
              sub="searches with results"
            />
            <MetricCard label="Website visitors" value={visitors !== null ? visitors.toLocaleString() : '—'} sub="GoatCounter" />
            <MetricCard
              label="Web searches / visitor"
              value={visitors ? (webSearches / visitors).toFixed(2) : '—'}
              sub="web app only"
            />
            <MetricCard label="Top platform" value={summary.top_platform ?? '—'} />
            <MetricCard label="Top streaming" value={summary.top_streaming_service ?? '—'} />
          </div>

          {/* Volume chart */}
          <div className="bg-surface-secondary rounded-xl border border-border p-5">
            <div className="flex flex-wrap items-center gap-4 mb-4">
              <h2 className="font-display text-sm font-semibold text-text-primary">
                {range.granularity === 'week' ? 'Weekly volume' : 'Daily volume'}
              </h2>
              <div className="ml-auto"><Legend series={SEARCH_SERIES} /></div>
            </div>
            <div className="text-text-primary">
              <BarChart data={chart} series={SEARCH_SERIES} label="Search, click and activation chart" />
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <Panel title="By client">
              <DataTable
                rows={clientRows}
                columns={[
                  { key: 'client', label: 'Client' },
                  { key: 'searches', label: 'Searches', align: 'right' },
                  { key: 'clicks', label: 'Clicks', align: 'right' },
                ]}
                emptyLabel="No app data yet"
              />
            </Panel>

            <Panel title="Searches by kind">
              <DataTable
                rows={kindRows}
                columns={[
                  { key: 'client', label: 'Client' },
                  { key: 'typed', label: 'Typed', align: 'right' },
                  { key: 'now_playing', label: 'Now playing', align: 'right' },
                  { key: 'unlabelled', label: 'Unlabelled', align: 'right' },
                ]}
              />
              <p className="text-text-muted text-xs mt-3">
                Unlabelled searches came from versions that didn’t say which kind they were: the web app before
                Oct 27, 2026, and the Mac app and extension before their next releases. The extension’s old
                versions counted every track change as a search; newer ones count once per artist you listen to.
              </p>
            </Panel>

            <Panel title="Platform clicks">
              <DataTable
                rows={platforms}
                columns={[
                  { key: 'platform', label: 'Platform' },
                  { key: 'clicks', label: 'Clicks', align: 'right' },
                ]}
                emptyLabel="No click data yet"
              />
            </Panel>

            <Panel title="Extension: streaming services">
              <DataTable
                rows={streaming_services}
                columns={[
                  { key: 'service', label: 'Service' },
                  { key: 'activations', label: 'Activations', align: 'right' },
                ]}
                emptyLabel="No extension activations yet"
              />
            </Panel>
          </div>

          <TrafficSection traffic={traffic} error={trafficError} />

        </div>
      </main>

      <Footer />
    </div>
  );
}
