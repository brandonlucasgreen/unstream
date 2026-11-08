// The arithmetic behind an artist's Analytics page. Locked here: streaming appearances are part
// of the search total and also counted on their own; release views add up per release; the
// activity list is day-level and count-only, newest first, fan actions before passive counts; and
// nothing older than the window, or about a release with no title, gets a line.

import { describe, it, expect } from 'vitest';
import { buildActivity, summarizeAnalytics, MAX_ACTIVITY_ITEMS, type ActivityInputs } from '../artist-activity';

const RELEASE = '11111111-1111-4111-8111-111111111111';

describe('summarizeAnalytics', () => {
  it('adds streaming appearances to searches and counts them on their own', () => {
    const { totals } = summarizeAnalytics([
      { date: '2026-11-01', metric: 'search', count: 3 },
      { date: '2026-11-02', metric: 'streaming', count: 2 },
    ], '2026-10-01');
    expect(totals.searches).toBe(5);
    expect(totals.streaming).toBe(2);
  });

  it('totals release views per release, and clicks per platform', () => {
    const summary = summarizeAnalytics([
      { date: '2026-11-01', metric: `release_view:${RELEASE}`, count: 2 },
      { date: '2026-11-02', metric: `release_view:${RELEASE}`, count: 1 },
      { date: '2026-11-02', metric: 'click:bandcamp', count: 4 },
      { date: '2026-11-02', metric: 'click:mirlo', count: 1 },
    ], '2026-10-01');
    expect(summary.totals.releaseViews).toBe(3);
    expect(summary.releaseViewsById).toEqual({ [RELEASE]: 3 });
    expect(summary.totals.clicks).toBe(5);
    expect(summary.clicksByPlatform).toEqual({ bandcamp: 4, mirlo: 1 });
  });

  it('leaves out rows before the period', () => {
    const { totals } = summarizeAnalytics([
      { date: '2026-09-01', metric: 'view', count: 10 },
      { date: '2026-11-01', metric: 'view', count: 1 },
    ], '2026-10-01');
    expect(totals.views).toBe(1);
  });
});

function inputs(overrides: Partial<ActivityInputs> = {}): ActivityInputs {
  return { analytics: [], saves: [], collected: [], tips: [], alerts: [], releaseTitles: {}, since: '2026-08-10', ...overrides };
}

describe('buildActivity', () => {
  it('turns each day into counts, never times', () => {
    const items = buildActivity(inputs({
      saves: [
        { addedAt: '2026-11-03T21:14:00Z', supported: false, supportedAt: null },
        { addedAt: '2026-11-03T08:02:00Z', supported: true, supportedAt: '2026-11-04T10:00:00Z' },
      ],
    }));
    expect(items).toEqual([
      { day: '2026-11-04', kind: 'supported', count: 1 },
      { day: '2026-11-03', kind: 'saved', count: 2 },
    ]);
  });

  it('puts fan actions before passive counts on the same day', () => {
    const items = buildActivity(inputs({
      analytics: [
        { date: '2026-11-03', metric: 'view', count: 4 },
        { date: '2026-11-03', metric: 'streaming', count: 1 },
      ],
      saves: [{ addedAt: '2026-11-03T12:00:00Z', supported: false, supportedAt: null }],
      tips: [{ createdAt: '2026-11-03T12:00:00Z', keptCents: 500 }],
    }));
    expect(items.map(i => i.kind)).toEqual(['tip', 'saved', 'streaming', 'view']);
  });

  it('groups a day of clicks into one line naming every platform', () => {
    const [item] = buildActivity(inputs({
      analytics: [
        { date: '2026-11-03', metric: 'click:bandcamp', count: 2 },
        { date: '2026-11-03', metric: 'click:mirlo', count: 1 },
      ],
    }));
    expect(item).toEqual({ day: '2026-11-03', kind: 'click', count: 3, platforms: ['bandcamp', 'mirlo'] });
  });

  it('sums a day of tips, and skips one fully refunded', () => {
    const [item, ...rest] = buildActivity(inputs({
      tips: [
        { createdAt: '2026-11-03T01:00:00Z', keptCents: 500 },
        { createdAt: '2026-11-03T02:00:00Z', keptCents: 700 },
        { createdAt: '2026-11-02T02:00:00Z', keptCents: 0 },
      ],
    }));
    expect(item).toEqual({ day: '2026-11-03', kind: 'tip', count: 2, amountCents: 1200 });
    expect(rest).toEqual([]);
  });

  it('names releases for views, collections and alerts, and drops views of a release with no title', () => {
    const items = buildActivity(inputs({
      analytics: [
        { date: '2026-11-03', metric: `release_view:${RELEASE}`, count: 2 },
        { date: '2026-11-03', metric: 'release_view:22222222-2222-4222-8222-222222222222', count: 9 },
      ],
      releaseTitles: { [RELEASE]: 'Lightbulbs' },
      collected: [{ createdAt: '2026-11-02T00:00:00Z', title: 'Lightbulbs' }],
      alerts: [{ sentAt: '2026-11-01T00:00:00Z', release: 'Lightbulbs', recipients: 4 }],
    }));
    expect(items).toEqual([
      { day: '2026-11-03', kind: 'release_view', count: 2, release: 'Lightbulbs' },
      { day: '2026-11-02', kind: 'collected', count: 1, release: 'Lightbulbs' },
      { day: '2026-11-01', kind: 'release_alert', count: 4, release: 'Lightbulbs' },
    ]);
  });

  it('leaves out anything before the window', () => {
    const items = buildActivity(inputs({
      since: '2026-11-01',
      saves: [{ addedAt: '2026-10-31T23:59:00Z', supported: true, supportedAt: '2026-11-02T00:00:00Z' }],
    }));
    // The old save is outside the window; the recent supported mark on it is not.
    expect(items).toEqual([{ day: '2026-11-02', kind: 'supported', count: 1 }]);
  });

  it('keeps to the newest items', () => {
    const analytics = Array.from({ length: 80 }, (_, i) => ({
      date: `2026-${String(9 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      metric: 'view',
      count: 1,
    }));
    const items = buildActivity(inputs({ analytics }));
    expect(items).toHaveLength(MAX_ACTIVITY_ITEMS);
    expect(items[0].day > items[items.length - 1].day).toBe(true);
  });
});
