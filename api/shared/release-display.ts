/**
 * Formatting for the release page: money, payout estimates, dates, freshness, ordering.
 *
 * Split out of the edge function so it can be tested. Edge functions run on Deno and import
 * from URLs, which puts them out of reach of vitest — the existing workaround for that has
 * been to copy the function into the test file and keep the copy in sync by hand. Everything
 * here makes a claim about someone's money or a release date, which is exactly the code that
 * shouldn't be verified against a copy of itself.
 *
 * Imported with an explicit `.ts` extension by the edge function (Deno requires it) and
 * without one by node — the same arrangement `bandcamp-friday.ts` already uses.
 */

import { PLATFORMS } from './platform-registry.ts';

/** Display order within a source: cheapest first, and anything you can't buy at the bottom. */
export const AVAILABILITY_ORDER: Record<string, number> = {
  available: 0,
  preorder: 1,
  unknown: 2,
  sold_out: 3,
};

export const FORMAT_LABELS: Record<string, string> = {
  digital: 'Digital',
  vinyl: 'Vinyl',
  cassette: 'Cassette',
  cd: 'CD',
  book: 'Book',
  merch: 'Merch',
  other: 'Other',
};

/** Only the states worth saying out loud — 'available' needs no label beside a price. */
export const AVAILABILITY_LABELS: Record<string, string> = {
  preorder: 'Pre-order',
  sold_out: 'Sold out',
  unknown: 'Price unknown',
};

/**
 * Money, in the currency the platform quoted.
 *
 * `Intl` rather than a symbol table: it already knows every currency, and an unrecognized code
 * degrades to "CAD 25" instead of a confidently wrong symbol.
 *
 * Two decimals or none — never one. A whole price reads "$25" rather than "$25.00", but
 * anything with cents reads in full: "$8.50", not "$8.5". Letting Intl choose the minimum
 * produces the second, which looks like a typo in a price. Cents are never rounded away,
 * because tidying someone's money is a small lie on a page whose entire job is being accurate
 * about it.
 */
export function formatMoney(amount: number, currency: string | null): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount} ${currency ?? ''}`.trim();
  }
}

/**
 * What goes in the price column.
 *
 * **Zero means name-your-price, not free.** Bandcamp reports a name-your-price release as
 * `price: 0` with no other signal, and rendering that as "$0" tells a fan the record costs
 * nothing — when in fact they're being invited to decide what to pay, which on a product about
 * paying artists is close to the opposite message. Caught on Kid Lightbulbs' own catalog, where
 * every release is name-your-price.
 *
 * A null price is a format we know exists but have no figure for; an em dash says that without
 * claiming it's free.
 */
export function formatOfferPrice(price: number | null, currency: string | null): string {
  if (price === null) return '—';
  if (price === 0) return 'Name your price';
  return formatMoney(price, currency);
}

/**
 * "≈$20–21.25 to the artist" — the emotional payload of the whole product, at the moment
 * someone is deciding where to buy.
 *
 * Deliberately a **range**, because the registry's payout figures are ranges ('80-85%', '~70%')
 * and they're honest about it: Bandcamp's real take differs between digital and physical,
 * payment processing comes off the top, and on a Bandcamp Friday it's ~97%. Asserting a single
 * precise figure about someone's income would be worse than saying "roughly". The string form
 * of `payoutPercent` makes false precision impossible by construction — keep it that way.
 *
 * Returns '' when there's no percentage or no price, rather than inventing either.
 */
export function payoutEstimate(
  price: number | null,
  currency: string | null,
  payoutPercent?: string
): string {
  if (price === null || price <= 0 || !payoutPercent) return '';

  const numbers = payoutPercent.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return '';

  const low = Number(numbers[0]) / 100;
  const high = Number(numbers[numbers.length - 1]) / 100;
  if (!Number.isFinite(low) || !Number.isFinite(high)) return '';

  const lowAmount = formatMoney(price * low, currency);
  const highAmount = formatMoney(price * high, currency);

  return lowAmount === highAmount
    ? `≈${lowAmount} to artist`
    : `≈${lowAmount}–${highAmount} to artist`;
}

/**
 * A release date rendered only as precisely as we actually know it.
 *
 * MusicBrainz returns year-only and month-only dates, and printing "1 January 2023" for a
 * year-only date states a fact no source ever gave us. `date_precision` exists for this, and
 * this is the one place it pays off.
 */
export function formatReleaseDate(date: string | null, precision: string | null): string {
  if (!date) return '';
  const [year, month, day] = date.split('-').map(Number);
  if (!Number.isFinite(year)) return '';

  const monthName = new Date(Date.UTC(year, (month || 1) - 1, 1))
    .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

  if (precision === 'year') return String(year);
  if (precision === 'month') return `${monthName} ${year}`;
  if (precision === 'day') return `${day} ${monthName} ${year}`;
  // 'unknown' precision on a stored date means we padded it ourselves. Say nothing rather
  // than pick a shape.
  return '';
}

/** "today" / "yesterday" / "3 days ago" — how old a price is, in words a person reads. */
export function relativeDays(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * The lower bound of a platform's payout range, for ordering sources on the page.
 *
 * Artist-paying options lead, always. A page that put "used CD, $2.64" above "vinyl direct from
 * the artist, $25" would be off-mission even though both facts are true — and once Discogs and
 * its secondhand marketplace join the catalog, that is exactly the page any other ordering
 * produces. Search already sorts this way; this is the same rule in a second place.
 *
 * Unknown platforms rank last rather than first.
 */
export function payoutRank(platform: string): number {
  const percent = PLATFORMS[platform]?.payoutPercent;
  const first = percent?.match(/\d+(?:\.\d+)?/)?.[0];
  return first ? Number(first) : -1;
}
