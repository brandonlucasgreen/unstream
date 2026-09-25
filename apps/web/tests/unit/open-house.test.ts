import { describe, it, expect } from 'vitest';
import ledger from '../../../../data/open-house/ledger.json';
import { costTotals, coveragePercent, formatUsd, type Ledger } from '../../src/services/openHouse';

describe('costTotals', () => {
  it('separates what is paid today from the full bill off every free tier', () => {
    expect(
      costTotals([
        { item: 'A', monthly: 25, paying: false, why: '' },
        { item: 'B', monthly: 8.25, paying: true, why: '' },
        { item: 'C', monthly: 0, paying: true, why: '' },
      ])
    ).toEqual({ current: 8.25, full: 33.25 });
  });

  it('rounds away floating-point drift', () => {
    const costs = [0.1, 0.2].map((monthly) => ({ item: String(monthly), monthly, paying: true, why: '' }));
    expect(costTotals(costs)).toEqual({ current: 0.3, full: 0.3 });
  });
});

describe('coveragePercent', () => {
  it('is revenue over cost as a whole percentage', () => {
    expect(coveragePercent(2600, 52)).toBe(50);
    expect(coveragePercent(7800, 52)).toBe(150);
  });

  it('is null when counts are withheld or there is nothing to cover', () => {
    expect(coveragePercent(null, 52)).toBeNull();
    expect(coveragePercent(1000, 0)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('drops cents on whole dollars and keeps them otherwise', () => {
    expect(formatUsd(25)).toBe('$25');
    expect(formatUsd(8.25)).toBe('$8.25');
  });
});

describe('data/open-house/ledger.json', () => {
  // The page trusts this file's shape; a hand edit that breaks it should fail CI, not the page.
  const data = ledger as Ledger;

  it('has the fields the page reads', () => {
    expect(typeof data.draft).toBe('boolean');
    expect(data.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.currency).toBe('USD');
    expect(Array.isArray(data.months)).toBe(true);
  });

  it('lists every cost with an amount, a paying flag and a reason', () => {
    expect(data.costs.length).toBeGreaterThan(0);
    for (const cost of data.costs) {
      expect(cost.item.length).toBeGreaterThan(0);
      expect(cost.why.length).toBeGreaterThan(0);
      expect(typeof cost.paying).toBe('boolean');
      expect(cost.monthly).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps closed months in YYYY-MM form with numeric totals', () => {
    for (const month of data.months) {
      expect(month.month).toMatch(/^\d{4}-\d{2}$/);
      for (const key of ['costs', 'processingFees', 'memberRevenue', 'tipFeeRevenue', 'otherRevenue'] as const) {
        expect(typeof month[key]).toBe('number');
      }
    }
  });
});
