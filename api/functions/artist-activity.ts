// The numbers and the activity list on an artist's Analytics page (/analytics/:slug), built from
// rows analytics-stats.ts has already read. Pure, so the arithmetic is tested without a database.
//
// **Why an activity list.** A claimed artist's month is small: in November 2026 the median one had
// 4 page views, no search appearances and no platform clicks in 30 days. A dashboard of charts
// would be a page of zeros. Listed one by one — "A fan saved you", "2 clicks to your Bandcamp" —
// the same numbers read as things that happened (Brandon, 2026-11-08).
//
// **Day-level only, counts only.** Every item is a day and a count, never a time and never a fan.
// At these volumes an exact timestamp ("saved you at 21:14") is enough to tell an artist which of
// their friends it was. No locations either, for the same reason.

/** One row of get_artist_analytics: a day's count for one metric. */
export interface AnalyticsRow {
  date: string;
  metric: string;
  count: number;
}

/**
 * The metrics artist_analytics holds, as analytics-event.ts accepts them:
 * - `search`: the artist's card appeared in a search (any client).
 * - `streaming`: the same, but the search came from the extension or Mac app noticing a fan
 *   listening to the artist on a streaming service. Recorded *instead of* `search`, so total
 *   search appearances are the two added together. Older extension and Mac versions still send
 *   `search` for these, so the split only counts from the releases that send `streaming`.
 * - `view`: the artist's page was viewed.
 * - `click:<platform>`: a fan followed one of the artist's links.
 * - `release_view:<release id>`: one of the artist's release pages was viewed.
 */
export const STREAMING_METRIC = 'streaming';
export const RELEASE_VIEW_PREFIX = 'release_view:';

export interface AnalyticsSummary {
  totals: {
    /** Every search appearance, streaming ones included. */
    searches: number;
    streaming: number;
    views: number;
    clicks: number;
    releaseViews: number;
  };
  clicksByPlatform: Record<string, number>;
  releaseViewsById: Record<string, number>;
  daily: Array<{ date: string; searches: number; views: number; clicks: number }>;
}

/** Totals for the rows on or after `since` (YYYY-MM-DD). */
export function summarizeAnalytics(rows: AnalyticsRow[], since: string): AnalyticsSummary {
  const totals = { searches: 0, streaming: 0, views: 0, clicks: 0, releaseViews: 0 };
  const clicksByPlatform: Record<string, number> = {};
  const releaseViewsById: Record<string, number> = {};
  const dailyMap = new Map<string, { searches: number; views: number; clicks: number }>();

  for (const row of rows) {
    if (row.date < since) continue;
    const day = dailyMap.get(row.date) ?? { searches: 0, views: 0, clicks: 0 };

    if (row.metric === 'search' || row.metric === STREAMING_METRIC) {
      totals.searches += row.count;
      day.searches += row.count;
      if (row.metric === STREAMING_METRIC) totals.streaming += row.count;
    } else if (row.metric === 'view') {
      totals.views += row.count;
      day.views += row.count;
    } else if (row.metric.startsWith('click:')) {
      const platform = row.metric.slice('click:'.length);
      totals.clicks += row.count;
      day.clicks += row.count;
      clicksByPlatform[platform] = (clicksByPlatform[platform] ?? 0) + row.count;
    } else if (row.metric.startsWith(RELEASE_VIEW_PREFIX)) {
      const releaseId = row.metric.slice(RELEASE_VIEW_PREFIX.length);
      totals.releaseViews += row.count;
      releaseViewsById[releaseId] = (releaseViewsById[releaseId] ?? 0) + row.count;
    }

    dailyMap.set(row.date, day);
  }

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, stats]) => ({ date, ...stats }));

  return { totals, clicksByPlatform, releaseViewsById, daily };
}

export type ActivityKind =
  | 'tip'
  | 'saved'
  | 'supported'
  | 'collected'
  | 'release_alert'
  | 'streaming'
  | 'click'
  | 'release_view'
  | 'view'
  | 'search';

export interface ActivityItem {
  /** YYYY-MM-DD, UTC — the same days artist_analytics counts in. */
  day: string;
  kind: ActivityKind;
  count: number;
  /** A release title, for the kinds that are about one release. */
  release?: string;
  /** Platform ids, for clicks. */
  platforms?: string[];
  /** For tips: what the artist kept, after refunds, summed over the day. */
  amountCents?: number;
}

export interface ActivityInputs {
  /** artist_analytics rows; anything before `since` is ignored. */
  analytics: AnalyticsRow[];
  /** The artist's current (not removed) saves. */
  saves: Array<{ addedAt: string | null; supportedAt: string | null; supported: boolean }>;
  /** Collection items linked to one of the artist's releases. */
  collected: Array<{ createdAt: string; title: string }>;
  /** Paid tips in the current Stripe mode, with what the artist kept. */
  tips: Array<{ createdAt: string; keptCents: number }>;
  /** Release alert emails sent, one entry per alert with its recipient count. */
  alerts: Array<{ sentAt: string; release: string; recipients: number }>;
  releaseTitles: Record<string, string>;
  since: string;
}

// Same-day items are ordered by what a fan did, most deliberate first: money, then a save, then
// the passive counts.
const KIND_ORDER: ActivityKind[] = [
  'tip', 'saved', 'supported', 'collected', 'release_alert', 'streaming', 'click', 'release_view', 'view', 'search',
];

export const MAX_ACTIVITY_ITEMS = 50;

const dayOf = (timestamp: string) => timestamp.slice(0, 10);

/** The activity list, newest day first, at most MAX_ACTIVITY_ITEMS items. */
export function buildActivity(inputs: ActivityInputs): ActivityItem[] {
  const items = new Map<string, ActivityItem>();
  const add = (key: string, item: Omit<ActivityItem, 'count'>, count: number) => {
    if (item.day < inputs.since || count <= 0) return;
    const existing = items.get(key);
    if (existing) {
      existing.count += count;
      if (item.amountCents) existing.amountCents = (existing.amountCents ?? 0) + item.amountCents;
      if (item.platforms) existing.platforms = [...new Set([...(existing.platforms ?? []), ...item.platforms])];
    } else {
      items.set(key, { ...item, count });
    }
  };

  for (const row of inputs.analytics) {
    const day = row.date;
    if (row.metric === STREAMING_METRIC) add(`${day}|streaming`, { day, kind: 'streaming' }, row.count);
    else if (row.metric === 'search') add(`${day}|search`, { day, kind: 'search' }, row.count);
    else if (row.metric === 'view') add(`${day}|view`, { day, kind: 'view' }, row.count);
    else if (row.metric.startsWith('click:')) {
      add(`${day}|click`, { day, kind: 'click', platforms: [row.metric.slice('click:'.length)] }, row.count);
    } else if (row.metric.startsWith(RELEASE_VIEW_PREFIX)) {
      const id = row.metric.slice(RELEASE_VIEW_PREFIX.length);
      const release = inputs.releaseTitles[id];
      // A release since removed from the catalogue has no title to show; its views still count
      // in the totals, but "3 views of a release" says nothing worth a line.
      if (release) add(`${day}|release_view|${id}`, { day, kind: 'release_view', release }, row.count);
    }
  }

  for (const save of inputs.saves) {
    if (save.addedAt) add(`${dayOf(save.addedAt)}|saved`, { day: dayOf(save.addedAt), kind: 'saved' }, 1);
    if (save.supported && save.supportedAt) {
      add(`${dayOf(save.supportedAt)}|supported`, { day: dayOf(save.supportedAt), kind: 'supported' }, 1);
    }
  }

  for (const item of inputs.collected) {
    const day = dayOf(item.createdAt);
    add(`${day}|collected|${item.title}`, { day, kind: 'collected', release: item.title }, 1);
  }

  for (const tip of inputs.tips) {
    if (tip.keptCents <= 0) continue;
    const day = dayOf(tip.createdAt);
    add(`${day}|tip`, { day, kind: 'tip', amountCents: tip.keptCents }, 1);
  }

  for (const alert of inputs.alerts) {
    const day = dayOf(alert.sentAt);
    add(`${day}|release_alert|${alert.release}`, { day, kind: 'release_alert', release: alert.release }, alert.recipients);
  }

  return [...items.values()]
    .sort((a, b) => b.day.localeCompare(a.day) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .slice(0, MAX_ACTIVITY_ITEMS);
}
