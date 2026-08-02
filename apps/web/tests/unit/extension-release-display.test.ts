// The browser extension's copy of the release-page money rules, checked against the original.
//
// `apps/extension/lib/release-display.js` exists because the extension is plain ES modules loaded
// straight from disk — no build step, no TypeScript — so it cannot import `api/shared/
// release-display.ts` the way the edge function and the API do. That makes it a hand-maintained
// second implementation of claims about someone's income, which is precisely the shape of the
// bug CLAUDE.md keeps warning about: payout figures are already duplicated across eight files,
// and one of those copies quoted an unsourced rate to Discord users for months.
//
// So rather than restating the expected strings a second time and hoping both copies get edited
// together, this drives the two implementations over the same inputs and asserts they agree.
// A change to either one that isn't mirrored fails here.

import { describe, it, expect } from 'vitest';
import {
  formatMoney as tsFormatMoney,
  formatOfferPrice as tsFormatOfferPrice,
  formatReleaseDate as tsFormatReleaseDate,
  payoutEstimate as tsPayoutEstimate,
} from '../../../../api/shared/release-display';
import {
  formatMoney as jsFormatMoney,
  formatOfferPrice as jsFormatOfferPrice,
  formatReleaseDate as jsFormatReleaseDate,
  payoutEstimate as jsPayoutEstimate,
  releaseSlugsFromUrl,
} from '../../../../apps/extension/lib/release-display.js';

describe('extension formatMoney matches the release page', () => {
  const cases: [number, string | null][] = [
    [25, 'USD'],
    [8.5, 'USD'],
    [21.25, 'USD'],
    [2.64, 'USD'],
    [0, 'USD'],
    [20, 'GBP'],
    [20, 'EUR'],
    [12.5, 'JPY'],
    [15, null],
  ];

  it.each(cases)('agrees on %s %s', (amount, currency) => {
    expect(jsFormatMoney(amount, currency)).toBe(tsFormatMoney(amount, currency));
  });

  it('still enforces two-decimals-or-none', () => {
    // Pinned outright as well as cross-checked: if both copies drifted the same way, agreement
    // alone would not catch it, and "$8.5" reads as a typo in a price.
    expect(jsFormatMoney(8.5, 'USD')).toBe('$8.50');
    expect(jsFormatMoney(25, 'USD')).toBe('$25');
  });
});

describe('extension formatOfferPrice matches the release page', () => {
  const cases: [number | null, string | null][] = [
    [0, 'USD'],
    [null, 'USD'],
    [5, 'USD'],
    [32, 'USD'],
  ];

  it.each(cases)('agrees on %s %s', (price, currency) => {
    expect(jsFormatOfferPrice(price, currency)).toBe(tsFormatOfferPrice(price, currency));
  });

  it('still treats zero as name-your-price, not free', () => {
    expect(jsFormatOfferPrice(0, 'USD')).toBe('Name your price');
  });
});

describe('extension payoutEstimate matches the release page', () => {
  const cases: [number | null, string | null, string | undefined][] = [
    [5, 'USD', '80-85%'],
    [32, 'USD', '80-85%'],
    [10, 'USD', '97%'],
    [10, 'USD', '~70%'],
    [8.5, 'USD', '90-97%'],
    [20, 'USD', undefined],
    [0, 'USD', '80-85%'],
    [null, 'USD', '80-85%'],
    [20, 'USD', 'unknown'],
  ];

  it.each(cases)('agrees on %s %s at %s', (price, currency, percent) => {
    expect(jsPayoutEstimate(price, currency, percent)).toBe(
      tsPayoutEstimate(price, currency, percent)
    );
  });

  it('still returns a range rather than a point estimate', () => {
    expect(jsPayoutEstimate(5, 'USD', '80-85%')).toBe('≈$4–$4.25 to artist');
  });

  it('says nothing rather than "≈$0 to artist" on a name-your-price offer', () => {
    expect(jsPayoutEstimate(0, 'USD', '80-85%')).toBe('');
  });
});

describe('extension formatReleaseDate matches the release page', () => {
  const cases: [string | null, string | null][] = [
    ['2024-12-06', 'day'],
    ['2025-10-23', 'month'],
    ['2023-01-01', 'year'],
    ['2025-01-01', 'unknown'],
    [null, 'day'],
  ];

  it.each(cases)('agrees on %s at %s precision', (date, precision) => {
    expect(jsFormatReleaseDate(date, precision)).toBe(tsFormatReleaseDate(date, precision));
  });

  it('still refuses to invent a day on a year-only date', () => {
    expect(jsFormatReleaseDate('2023-01-01', 'year')).toBe('2023');
  });
});

describe('releaseSlugsFromUrl', () => {
  it('reads both slugs out of an Unstream release URL', () => {
    expect(releaseSlugsFromUrl('https://unstream.stream/a/kid-lightbulbs/ruined-castle')).toEqual({
      artist: 'kid-lightbulbs',
      release: 'ruined-castle',
    });
  });

  it('returns null for a shop URL, so scrape-path alerts still just open the link', () => {
    // These alerts point at one platform and have no catalogued release behind them; fetching a
    // guide for one would 404.
    expect(releaseSlugsFromUrl('https://kidlightbulbs.bandcamp.com/album/ruined-castle')).toBeNull();
  });

  it('returns null for an artist page, which is not a release', () => {
    expect(releaseSlugsFromUrl('https://unstream.stream/a/kid-lightbulbs')).toBeNull();
  });

  it('rejects a lookalike host', () => {
    expect(releaseSlugsFromUrl('https://unstream.stream.evil.example/a/x/y')).toBeNull();
  });

  it('rejects garbage rather than throwing', () => {
    expect(releaseSlugsFromUrl('not a url')).toBeNull();
  });
});
