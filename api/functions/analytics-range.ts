// The date range /admin/analytics asks about, shared by the search dashboard
// (analytics-dashboard.ts) and the website traffic panel (analytics-traffic.ts) so the two
// always answer for exactly the same days.
//
// A range is whole UTC days, `from` and `to` both inclusive. The analytics_* SQL functions take
// it as [since, until) between UTC midnights, which is what lets the 90-day raw table and the
// whole-day rollup answer the same question (20261027120000_analytics-date-ranges.sql).

const DAY_MS = 24 * 60 * 60 * 1000;

/** app_events began on 2026-04-12; nothing exists before it, so a range never starts earlier. */
export const ANALYTICS_START = '2026-04-12';
export const DEFAULT_RANGE_DAYS = 30;
/** A chart with more days than this groups them by week. */
export const MAX_DAILY_BARS = 92;

export interface AnalyticsRange {
  from: string;
  to: string;
  days: number;
  /** UTC midnight starting `from`. */
  since: string;
  /** UTC midnight after `to`: exclusive. */
  until: string;
  granularity: 'day' | 'week';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Reads `from` and `to` (YYYY-MM-DD) from the query string. Both missing means the last 30 days
 * including today. A range reaching past today or before ANALYTICS_START is trimmed to the days
 * that can have data rather than refused, so a "last 12 months" preset works on a young table.
 */
export function parseAnalyticsRange(
  params: Record<string, string | undefined> | null | undefined,
  now: Date = new Date(),
): AnalyticsRange | { error: string } {
  const today = now.toISOString().slice(0, 10);
  const fromParam = params?.from;
  const toParam = params?.to;

  if ((fromParam && !isRealDate(fromParam)) || (toParam && !isRealDate(toParam))) {
    return { error: 'from and to must be dates in YYYY-MM-DD form' };
  }

  let to = toParam || today;
  let from = fromParam || addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (to > today) to = today;
  if (from < ANALYTICS_START) from = ANALYTICS_START;
  if (from > to) {
    return { error: 'from must be on or before to' };
  }

  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  return {
    from,
    to,
    days,
    since: `${from}T00:00:00.000Z`,
    until: `${addDays(to, 1)}T00:00:00.000Z`,
    granularity: days > MAX_DAILY_BARS ? 'week' : 'day',
  };
}

/** Every date in the range, oldest first. */
export function datesInRange(range: Pick<AnalyticsRange, 'from' | 'days'>): string[] {
  return Array.from({ length: range.days }, (_, i) => addDays(range.from, i));
}

/**
 * The chart bucket a date falls in: the date itself, or for weekly charts the Monday starting
 * its week (clamped to the range start, so the first bar is labelled with a day in the range).
 */
export function bucketStart(date: string, range: Pick<AnalyticsRange, 'from' | 'granularity'>): string {
  if (range.granularity === 'day') return date;
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(date, -((weekday + 6) % 7));
  return monday < range.from ? range.from : monday;
}
