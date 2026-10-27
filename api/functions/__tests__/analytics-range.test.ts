// The date range /admin/analytics asks about. The SQL functions only answer exactly when a range
// is whole UTC days (20261027120000_analytics-date-ranges.sql), so these pin that every range
// comes out as UTC midnights, `until` exclusive.

import { describe, it, expect } from 'vitest';
import { bucketStart, datesInRange, parseAnalyticsRange, type AnalyticsRange } from '../analytics-range';

const NOW = new Date('2026-10-27T15:30:00Z');

function parse(params: Record<string, string>) {
  const range = parseAnalyticsRange(params, NOW);
  if ('error' in range) throw new Error(range.error);
  return range;
}

describe('parseAnalyticsRange', () => {
  it('defaults to the last 30 days including today', () => {
    expect(parse({})).toEqual({
      from: '2026-09-28',
      to: '2026-10-27',
      days: 30,
      since: '2026-09-28T00:00:00.000Z',
      until: '2026-10-28T00:00:00.000Z',
      granularity: 'day',
    });
  });

  it('takes an explicit range, both ends inclusive', () => {
    const range = parse({ from: '2026-10-01', to: '2026-10-01' });
    expect(range.days).toBe(1);
    expect(range.until).toBe('2026-10-02T00:00:00.000Z');
  });

  it('trims a range to the days that can have data', () => {
    const range = parse({ from: '2025-10-27', to: '2026-12-31' });
    expect(range.from).toBe('2026-04-12');
    expect(range.to).toBe('2026-10-27');
  });

  it('groups by week past 92 days', () => {
    expect(parse({ from: '2026-07-28', to: '2026-10-27' }).granularity).toBe('day'); // 92 days
    expect(parse({ from: '2026-07-27', to: '2026-10-27' }).granularity).toBe('week');
  });

  it.each([
    [{ from: '2026-10-32' }],
    [{ to: '27/10/2026' }],
    [{ from: '2026-02-30' }],
    [{ from: '2026-10-20', to: '2026-10-10' }],
  ])('refuses %j', params => {
    expect(parseAnalyticsRange(params, NOW)).toHaveProperty('error');
  });
});

describe('bucketStart', () => {
  const weekly: Pick<AnalyticsRange, 'from' | 'granularity'> = { from: '2026-10-01', granularity: 'week' };

  it('returns the date itself for daily charts', () => {
    expect(bucketStart('2026-10-15', { from: '2026-10-01', granularity: 'day' })).toBe('2026-10-15');
  });

  it('returns the Monday of the week for weekly charts', () => {
    expect(bucketStart('2026-10-15', weekly)).toBe('2026-10-12'); // a Thursday
    expect(bucketStart('2026-10-18', weekly)).toBe('2026-10-12'); // a Sunday
    expect(bucketStart('2026-10-12', weekly)).toBe('2026-10-12'); // a Monday
  });

  it('starts the first week at the range start', () => {
    expect(bucketStart('2026-10-02', weekly)).toBe('2026-10-01');
  });
});

describe('datesInRange', () => {
  it('lists every day, oldest first, across a month end', () => {
    expect(datesInRange({ from: '2026-09-29', days: 3 })).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
  });
});
