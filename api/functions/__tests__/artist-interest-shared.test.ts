// The shared "I'd tip them" / Play my city rules, and how search results pick the counts up.

import { describe, it, expect } from 'vitest';
import {
  cityKey,
  cleanCityLabel,
  formatCityCounts,
  isEmptyInterest,
  parseInterestRow,
} from '../../shared/artist-interest';
import { attachInterestCounts, attachTipsEnabled, type AggregatedResult } from '../search-utils';

describe('cleanCityLabel', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanCityLabel('  New   York ')).toBe('New York');
  });

  it('keeps non-Latin place names', () => {
    expect(cleanCityLabel('東京')).toBe('東京');
    expect(cleanCityLabel('São Paulo')).toBe('São Paulo');
  });

  it('rejects empty, oversized, non-string and markup input', () => {
    expect(cleanCityLabel('')).toBeNull();
    expect(cleanCityLabel('   ')).toBeNull();
    expect(cleanCityLabel('x'.repeat(101))).toBeNull();
    expect(cleanCityLabel(42)).toBeNull();
    expect(cleanCityLabel('<b>Leeds</b>')).toBeNull();
    expect(cleanCityLabel('Leeds\u0000')).toBeNull();
  });
});

describe('cityKey', () => {
  it('groups case and trailing punctuation together', () => {
    expect(cityKey('Boston')).toBe(cityKey('boston.'));
    expect(cityKey('BOSTON,')).toBe('boston');
  });

  it('keeps a qualifier as part of the key', () => {
    expect(cityKey('Boston, MA')).toBe('boston, ma');
  });
});

describe('parseInterestRow', () => {
  it('reads a well-formed row', () => {
    expect(parseInterestRow({ tip_count: 4, cities: [{ label: 'Leeds', count: 3 }] }))
      .toEqual({ tipCount: 4, cities: [{ label: 'Leeds', count: 3 }] });
  });

  it('drops malformed city entries and non-numeric counts', () => {
    expect(parseInterestRow({ tip_count: '4', cities: [{ label: 1 }, null, { label: 'Leeds', count: 3 }] }))
      .toEqual({ tipCount: 0, cities: [{ label: 'Leeds', count: 3 }] });
  });
});

describe('formatting', () => {
  it('formats cities as the artist page shows them', () => {
    expect(formatCityCounts([{ label: 'Boston', count: 12 }, { label: 'Leeds', count: 5 }]))
      .toBe('Boston (12), Leeds (5)');
  });

  it('treats a missing or all-zero value as empty', () => {
    expect(isEmptyInterest(null)).toBe(true);
    expect(isEmptyInterest({ tipCount: 0, cities: [] })).toBe(true);
    expect(isEmptyInterest({ tipCount: 3, cities: [] })).toBe(false);
  });
});

describe('attachInterestCounts', () => {
  const result = (overrides: Partial<AggregatedResult>): AggregatedResult => ({
    id: 'x', name: 'X', type: 'artist', platforms: [], ...overrides,
  });

  it('attaches by page slug, claimed or known', () => {
    const claimed = result({ claimedSlug: 'kid-lightbulbs' });
    const known = result({ knownSlug: 'big-thief' });
    const none = result({});
    attachInterestCounts([claimed, known, none], new Map([
      ['kid-lightbulbs', { tipCount: 3, cities: [] }],
      ['big-thief', { tipCount: 0, cities: [{ label: 'Leeds', count: 4 }] }],
    ]));
    expect(claimed.interest).toEqual({ tipCount: 3, cities: [] });
    expect(known.interest?.cities).toEqual([{ label: 'Leeds', count: 4 }]);
    expect(none.interest).toBeUndefined();
  });

  it('leaves results alone when the read failed or nothing reached the threshold', () => {
    const r = result({ knownSlug: 'big-thief' });
    attachInterestCounts([r], null);
    attachInterestCounts([r], new Map([['big-thief', { tipCount: 0, cities: [] }]]));
    expect(r.interest).toBeUndefined();
  });
});

describe('attachTipsEnabled', () => {
  it('flags only results whose page slug is taking tips', () => {
    const taking = { id: 'a', name: 'A', type: 'artist' as const, platforms: [], claimedSlug: 'a' };
    const not = { id: 'b', name: 'B', type: 'artist' as const, platforms: [], knownSlug: 'b' };
    attachTipsEnabled([taking, not], new Set(['a']));
    expect(taking).toHaveProperty('tipsEnabled', true);
    expect(not).not.toHaveProperty('tipsEnabled');
    attachTipsEnabled([not], null);
    expect(not).not.toHaveProperty('tipsEnabled');
  });
});
