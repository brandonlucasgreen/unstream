// Formatting for the release page.
//
// Everything here makes a claim about someone's money or a release date on a page whose whole
// job is being accurate about both — so the properties worth locking are the ones where being
// subtly wrong looks fine: a fabricated day on a year-only date, false precision on a payout,
// a secondhand marketplace ranked above the artist's own store.

import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  formatReleaseDate,
  payoutEstimate,
  payoutRank,
  relativeDays,
} from '../../shared/release-display';

describe('formatMoney', () => {
  it('drops trailing zeros but keeps real cents', () => {
    expect(formatMoney(25, 'USD')).toBe('$25');
    expect(formatMoney(21.25, 'USD')).toBe('$21.25');
    expect(formatMoney(8.5, 'USD')).toBe('$8.50');
  });

  it('uses the currency the platform actually quoted', () => {
    expect(formatMoney(20, 'GBP')).toBe('£20');
    expect(formatMoney(20, 'EUR')).toBe('€20');
  });

  // A wrong symbol asserts the wrong price. A currency code in front of the number doesn't.
  it('degrades to something honest for a currency it does not know', () => {
    const out = formatMoney(20, 'ZZZ');
    expect(out).toContain('20');
    expect(out).not.toContain('$');
  });

  it('falls back to USD when a source gave no currency', () => {
    expect(formatMoney(10, null)).toBe('$10');
  });
});

describe('payoutEstimate', () => {
  // The number the whole product is built to show, at the moment someone decides where to buy.
  it('turns a payout range and a price into a money range', () => {
    expect(payoutEstimate(30, 'USD', '80-85%')).toBe('≈$24–$25.50 to artist');
    expect(payoutEstimate(10, 'USD', '80-85%')).toBe('≈$8–$8.50 to artist');
  });

  it('collapses to a single figure when the platform publishes one', () => {
    expect(payoutEstimate(20, 'USD', '~70%')).toBe('≈$14 to artist');
    expect(payoutEstimate(20, 'USD', '100%')).toBe('≈$20 to artist');
  });

  // Silence beats a made-up number. A missing price or an unknown payout are both cases where
  // any output at all would be an invention.
  it('says nothing rather than guessing', () => {
    expect(payoutEstimate(null, 'USD', '80-85%')).toBe('');
    expect(payoutEstimate(25, 'USD', undefined)).toBe('');
    expect(payoutEstimate(25, 'USD', 'varies')).toBe('');
    expect(payoutEstimate(0, 'USD', '80-85%')).toBe(''); // name-your-price at zero
  });
});

describe('formatReleaseDate', () => {
  it('renders a full date only when the source gave one', () => {
    expect(formatReleaseDate('2023-09-15', 'day')).toBe('15 September 2023');
  });

  // The fabrication `date_precision` exists to prevent: MusicBrainz year-only dates are stored
  // padded to 1 January, and printing that day states a fact no source ever gave us.
  it('never invents a day or a month it was not given', () => {
    expect(formatReleaseDate('2023-01-01', 'year')).toBe('2023');
    expect(formatReleaseDate('2023-09-01', 'month')).toBe('September 2023');
    expect(formatReleaseDate('2023-01-01', 'unknown')).toBe('');
  });

  it('renders nothing for a missing date', () => {
    expect(formatReleaseDate(null, 'day')).toBe('');
    expect(formatReleaseDate('', 'day')).toBe('');
  });
});

describe('relativeDays', () => {
  const now = new Date('2026-07-31T12:00:00Z');

  it('reads as words rather than a timestamp', () => {
    expect(relativeDays('2026-07-31T09:00:00Z', now)).toBe('today');
    expect(relativeDays('2026-07-30T09:00:00Z', now)).toBe('yesterday');
    expect(relativeDays('2026-07-28T09:00:00Z', now)).toBe('3 days ago');
  });

  it('does not claim a price was checked in the future', () => {
    expect(relativeDays('2026-08-02T09:00:00Z', now)).toBe('just now');
  });
});

describe('payoutRank', () => {
  // Artist-paying options lead, always. Once Discogs and its secondhand marketplace join the
  // catalog, any other ordering puts "used CD $2.64" above "vinyl direct from the artist $25".
  it('orders platforms by the bottom of their payout range', () => {
    expect(payoutRank('mirlo')).toBeGreaterThan(payoutRank('bandcamp'));
  });

  it('ranks a platform we know nothing about last', () => {
    expect(payoutRank('not-a-platform')).toBeLessThan(payoutRank('bandcamp'));
  });
});
