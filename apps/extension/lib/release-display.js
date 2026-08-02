// Formatting for a release's buying guide in the popup.
//
// Mirrors api/shared/release-display.ts, which formats the same numbers on the web release page.
// Every function here makes a claim about someone's money, so the rules — two decimals or none,
// zero meaning name-your-price, payout as a range never a point estimate — must not drift
// between the two.
//
// Note what is *not* here: payout percentages. Those come off the wire from
// GET /api/release/{artist}/{release}, which computes them per source. `PAYOUT_PERCENTAGES` in
// constants.js is a hand-maintained copy of the registry (one of eight in this repo), and a copy
// is exactly how the Discord bot ended up quoting an unsourced rate for months. The response also
// carries the Bandcamp Friday override, which the local table has no way to know about.

export const FORMAT_LABELS = {
  digital: 'Digital',
  vinyl: 'Vinyl',
  cassette: 'Cassette',
  cd: 'CD',
  book: 'Book',
  merch: 'Merch',
  other: 'Other',
};

/** Only the states worth saying out loud — 'available' needs no label beside a price. */
export const AVAILABILITY_LABELS = {
  preorder: 'Pre-order',
  sold_out: 'Sold out',
  unknown: 'Price unknown',
};

export function formatLabel(format) {
  return FORMAT_LABELS[format] || (format ? format[0].toUpperCase() + format.slice(1) : 'Other');
}

/**
 * Money, in the currency the platform quoted.
 *
 * Two decimals or none — never one. "$25", never "$25.00"; "$8.50", never "$8.5", which looks
 * like a typo in a price. Cents are never rounded away: tidying someone's money is a small lie
 * in a product whose entire job is being accurate about it.
 */
export function formatMoney(amount, currency) {
  const digits = Number.isInteger(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount} ${currency || ''}`.trim();
  }
}

/**
 * What goes in the price column.
 *
 * **Zero means name-your-price, not free.** Bandcamp reports a name-your-price release as
 * `price: 0` with no other signal, and rendering "$0" tells a fan the record costs nothing when
 * they are being invited to decide what to pay — close to the opposite message in an extension
 * about paying artists. A null price is a format we know exists but have no figure for; an em
 * dash says that without claiming it's free.
 */
export function formatOfferPrice(price, currency) {
  if (price === null || price === undefined) return '—';
  if (price === 0) return 'Name your price';
  return formatMoney(price, currency);
}

/**
 * "≈$4–$4.25 to artist" — the reason this panel exists, at the moment someone is deciding where
 * to buy.
 *
 * Deliberately a range, because the payout figures are ranges and they are honest about it:
 * Bandcamp's real take differs between digital and physical, payment processing comes off the
 * top, and on a Bandcamp Friday it's ~97%. Returns '' rather than inventing a figure.
 */
export function payoutEstimate(price, currency, payoutPercent) {
  if (price === null || price === undefined || price <= 0 || !payoutPercent) return '';

  const numbers = String(payoutPercent).match(/\d+(?:\.\d+)?/g);
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
 * year-only date states a fact no source ever gave us. `datePrecision` exists for this.
 */
export function formatReleaseDate(date, precision) {
  if (!date) return '';
  const [year, month, day] = date.split('-').map(Number);
  if (!Number.isFinite(year)) return '';

  if (precision === 'year') return String(year);

  const monthName = new Date(Date.UTC(year, (month || 1) - 1, 1))
    .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

  if (precision === 'month') return `${monthName} ${year}`;
  if (precision === 'day') return `${day} ${monthName} ${year}`;
  // 'unknown' precision on a stored date means we padded it ourselves. Say nothing rather than
  // pick a shape.
  return '';
}

/**
 * The two slugs in an Unstream release URL, or null.
 *
 * Alerts carry `releaseUrl` as the Unstream release page rather than a shop's — pillar 3 of the
 * releases spec — so a catalogued release already has everything the endpoint needs. Alerts from
 * the older per-platform scrape path carry a shop URL instead; null tells the caller there is no
 * guide behind this one and it should just open the link.
 */
export function releaseSlugsFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'unstream.stream') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'a') return null;
    return { artist: parts[1], release: parts[2] };
  } catch {
    return null;
  }
}
