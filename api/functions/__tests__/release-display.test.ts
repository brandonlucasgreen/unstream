// Formatting for the release page.
//
// Everything here makes a claim about someone's money or a release date on a page whose whole
// job is being accurate about both — so the properties worth locking are the ones where being
// subtly wrong looks fine: a fabricated day on a year-only date, false precision on a payout,
// a secondhand marketplace ranked above the artist's own store.

import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  formatOfferPrice,
  formatReleaseDate,
  leadingOfferSummary,
  oneSourcePerPlatform,
  orderedSourcePlatforms,
  payoutEstimate,
  payoutRank,
  relativeDays,
  releaseTypeLabel,
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

describe('formatOfferPrice', () => {
  // Bandcamp reports name-your-price as `price: 0` with no other signal. Rendering "$0" tells a
  // fan the record is free when they're actually being asked to decide what to pay — close to
  // the opposite message on a product about paying artists. Caught on Kid Lightbulbs' own
  // catalog, where every release is name-your-price.
  it('reads zero as name-your-price, not free', () => {
    expect(formatOfferPrice(0, 'USD')).toBe('Name your price');
  });

  it('says nothing about cost when there is no figure', () => {
    expect(formatOfferPrice(null, 'USD')).toBe('—');
  });

  it('renders a real price normally', () => {
    expect(formatOfferPrice(25, 'USD')).toBe('$25');
    expect(formatOfferPrice(8.5, 'GBP')).toBe('£8.50');
  });
});

describe('orderedSourcePlatforms', () => {
  it('orders artist-paying-first, matching the release page itself', () => {
    expect(orderedSourcePlatforms([{ platform: 'discogs', offers: [] }, { platform: 'bandcamp', offers: [] }]))
      .toEqual(['bandcamp', 'discogs']);
  });
});

describe('leadingOfferSummary', () => {
  const offer = (price: number | null, availability = 'available') =>
    ({ price, currency: 'USD', availability });
  const source = (platform: string, offers: ReturnType<typeof offer>[]) => ({ platform, offers });

  it('quotes the cheapest buyable offer from a single source, with its payout estimate', () => {
    expect(leadingOfferSummary([source('bandcamp', [offer(25), offer(8), offer(12)])]))
      .toBe('from $8 · ≈$6.40–$6.80 to artist');
  });

  // The whole reason this isn't just "globally cheapest": once Discogs (no payout figure,
  // secondhand) is a second source, picking the absolute cheapest price could rank a used
  // copy above the artist's own store — exactly the anti-pattern the sourcing spec warns
  // against ("used CD $2.64" above "vinyl direct from the artist $30").
  it('prefers the artist-paying source even when a lower-payout source is cheaper', () => {
    const out = leadingOfferSummary([
      source('discogs', [offer(3)]),
      source('bandcamp', [offer(25)]),
    ]);
    expect(out).toContain('$25');
    expect(out).not.toContain('$3');
  });

  it('falls through to the next source when the leading one has nothing buyable', () => {
    const out = leadingOfferSummary([
      source('bandcamp', [offer(8, 'sold_out')]),
      source('discogs', [offer(12)]),
    ]);
    expect(out).toBe('from $12'); // discogs has no payout percent, so no estimate is shown
  });

  it('ignores sold-out formats when picking the cheapest within a source', () => {
    expect(leadingOfferSummary([source('bandcamp', [offer(25), offer(8, 'sold_out')])])).toContain('$25');
  });

  it('says name-your-price rather than "from $0"', () => {
    expect(leadingOfferSummary([source('bandcamp', [offer(0)])])).toBe('Name your price');
  });

  // The normal state for a release catalogued from the Bandcamp grid, whose own page hasn't
  // been read for prices yet. Silence, not a zero.
  it('says nothing when there are no sources, no offers, or no prices', () => {
    expect(leadingOfferSummary([])).toBe('');
    expect(leadingOfferSummary([source('bandcamp', [])])).toBe('');
    expect(leadingOfferSummary([source('bandcamp', [offer(null)])])).toBe('');
  });
});

describe('releaseTypeLabel', () => {
  it('uses the upstream type when there is one', () => {
    expect(releaseTypeLabel('album', ['bandcamp'])).toBe('Album');
    expect(releaseTypeLabel('ep', ['mirlo'])).toBe('Ep');
    expect(releaseTypeLabel('compilation', ['discogs'])).toBe('Compilation');
  });

  it('says Digital for an unknown type sold only on download-only platforms', () => {
    // The normal case on Mirlo, Faircamp and Jam.coop: none of them expose a type field, so
    // without this every one of their releases shows no label at all.
    expect(releaseTypeLabel('other', ['mirlo'])).toBe('Digital');
    expect(releaseTypeLabel('other', ['faircamp'])).toBe('Digital');
    expect(releaseTypeLabel('other', ['jamcoop'])).toBe('Digital');
    expect(releaseTypeLabel('other', ['mirlo', 'jamcoop'])).toBe('Digital');
  });

  it('refuses Digital when ANY platform might sell something physical', () => {
    // The failure this prevents: a release on Mirlo *and* Bandcamp may well exist as a vinyl
    // pressing, and "Digital" would then be a wrong claim about a physical product. One
    // unflagged platform is enough to fall back to no label.
    expect(releaseTypeLabel('other', ['mirlo', 'bandcamp'])).toBe('');
    expect(releaseTypeLabel('other', ['bandcamp'])).toBe('');
    expect(releaseTypeLabel('other', ['discogs'])).toBe('');
    // An unrecognized platform is unknown, not digital.
    expect(releaseTypeLabel('other', ['mirlo', 'somethingnew'])).toBe('');
  });

  it('says nothing when there are no platforms at all', () => {
    // No sources is an absence of evidence, not evidence of digital — the same distinction the
    // ingest layer draws between "no price configured" and "free".
    expect(releaseTypeLabel('other', [])).toBe('');
    expect(releaseTypeLabel(null, [])).toBe('');
  });

  it('never renders the literal word "Other"', () => {
    // It never has, on any surface. "Other · 4 July 2026 · $4" tells a fan nothing.
    for (const platforms of [[], ['bandcamp'], ['mirlo'], ['discogs', 'mirlo']]) {
      expect(releaseTypeLabel('other', platforms)).not.toBe('Other');
    }
  });
});

describe('oneSourcePerPlatform', () => {
  // A release can hold two Discogs sources since it became possible to merge two masters into
  // one record. Both URLs are real; two rows on a buying guide are not — the page would read
  // "Discogs · Discogs" and print one platform's payout cut twice.
  const withOffers = { platform: 'discogs', external_id: 'master-2', release_offers: [{ price: 12 }], detail_checked_at: null };
  const bare = { platform: 'discogs', external_id: 'master-1', release_offers: [], detail_checked_at: null };

  it('keeps the listing that actually has offers over an empty one', () => {
    expect(oneSourcePerPlatform([bare, withOffers])).toEqual([withOffers]);
  });

  it('prefers a source the artist claimed over anything ingest found', () => {
    const claimed = { platform: 'discogs', external_id: null, source: 'claimed', release_offers: [], detail_checked_at: null };
    expect(oneSourcePerPlatform([withOffers, claimed])).toEqual([claimed]);
  });

  it('leaves distinct platforms alone, in input order', () => {
    const bandcamp = { platform: 'bandcamp', external_id: 'album-1', release_offers: [], detail_checked_at: null };
    expect(oneSourcePerPlatform([bandcamp, withOffers])).toEqual([bandcamp, withOffers]);
  });

  it('picks the first of equally good candidates rather than an arbitrary one', () => {
    const a = { platform: 'discogs', external_id: 'a', release_offers: [], detail_checked_at: null };
    const b = { platform: 'discogs', external_id: 'b', release_offers: [], detail_checked_at: null };
    expect(oneSourcePerPlatform([a, b])).toEqual([a]);
    expect(oneSourcePerPlatform([b, a])).toEqual([b]);
  });

  // The winner is tracked by identity, not by index or value — a caller that round-trips the
  // input through JSON (serializing across a worker boundary, a cache layer) must not lose
  // every source for a platform just because `===` no longer holds between the input array and
  // itself.
  it('survives sources that have been serialized and re-parsed', () => {
    const roundTripped = JSON.parse(JSON.stringify([bare, withOffers]));
    expect(oneSourcePerPlatform(roundTripped)).toEqual([withOffers]);
  });

  // Two array slots pointing at the same object is a degenerate case (a dedupe bug upstream,
  // say) — it must still keep one source rather than filtering the platform out entirely.
  it('keeps one source even when the same object appears twice in the input', () => {
    expect(oneSourcePerPlatform([withOffers, withOffers])).toEqual([withOffers]);
  });
});

describe('orderedSourcePlatforms — duplicates', () => {
  it('names each platform once even when a release holds two of its sources', () => {
    expect(orderedSourcePlatforms([
      { platform: 'discogs', offers: [] },
      { platform: 'bandcamp', offers: [] },
      { platform: 'discogs', offers: [] },
    ])).toEqual(['bandcamp', 'discogs']);
  });
});
