// Tip amounts, fees and the breakdown shown before paying (docs/specs/artist-patronage-spec.md §5).
// One definition for the server (which decides every figure that reaches Stripe) and the tip page
// (which only displays them). Plain TypeScript, no imports, so Deno can use it too.
//
// Stripe's standard US card pricing is assumed: 2.9% + 30¢, paid by the artist's account.
// International cards (+~1.5%) and currency conversion (+~1%) cost more; the "cover the fees"
// gross-up uses the standard rate, so on those cards the artist nets slightly less than chosen.

export const STRIPE_PERCENT = 0.029;
export const STRIPE_FIXED_CENTS = 30;

/** One-off tips: minimum $3 — a $1 card charge loses a third to the fixed fee. */
export const ONE_OFF_MIN_CENTS = 300;
/** A ceiling against typos and card-testing: $500. */
export const ONE_OFF_MAX_CENTS = 50000;
export const ONE_OFF_PRESETS_CENTS = [500, 1000, 2000];

/** Unstream's fee is the artist's choice: 0–5%, default 0. */
export const MAX_FEE_BASIS_POINTS = 500;

/** Up to three open goals per artist (spec §3.4). */
export const MAX_OPEN_GOALS = 3;
export const MAX_GOAL_TITLE_LENGTH = 80;

/**
 * Bumped when the artist addendum's wording changes, so the change can be re-accepted. Stored on
 * artist_tip_accounts.addendum_version.
 */
export const ARTIST_ADDENDUM_VERSION = '2026-10-03';

export interface TipBreakdown {
  /** What the fan chose to give the artist. */
  amountCents: number;
  /** What the fan pays: equal to amountCents unless they cover the fees. */
  grossCents: number;
  /** Stripe's processing fee, estimated at the standard rate. */
  stripeFeeCents: number;
  /** Unstream's fee, sent to Stripe as application_fee_amount. */
  applicationFeeCents: number;
  /** What reaches the artist, estimated. */
  artistNetCents: number;
}

/** Stripe's standard fee on a charge, rounded to the cent. */
export function estimatedStripeFeeCents(grossCents: number): number {
  return Math.round(grossCents * STRIPE_PERCENT + STRIPE_FIXED_CENTS);
}

/**
 * The figures for one charge. With `coverFees`, the charge is grossed up so the artist nets the
 * chosen amount: (amount + 0.30) / (1 − 0.029 − fee%), rounded up to the cent so rounding never
 * shortchanges the artist.
 */
export function tipBreakdown(amountCents: number, coverFees: boolean, feeBasisPoints: number): TipBreakdown {
  const feeRate = feeBasisPoints / 10000;
  const grossCents = coverFees
    ? Math.ceil((amountCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT - feeRate))
    : amountCents;
  const applicationFeeCents = Math.round(grossCents * feeRate);
  const stripeFeeCents = estimatedStripeFeeCents(grossCents);
  return {
    amountCents,
    grossCents,
    stripeFeeCents,
    applicationFeeCents,
    artistNetCents: grossCents - stripeFeeCents - applicationFeeCents,
  };
}

export function isValidOneOffAmount(amountCents: unknown): amountCents is number {
  return typeof amountCents === 'number'
    && Number.isInteger(amountCents)
    && amountCents >= ONE_OFF_MIN_CENTS
    && amountCents <= ONE_OFF_MAX_CENTS;
}

export function isValidFeeBasisPoints(bps: unknown): bps is number {
  return typeof bps === 'number' && Number.isInteger(bps) && bps >= 0 && bps <= MAX_FEE_BASIS_POINTS;
}

/** "$5.46", "$2,400.00" */
export function formatUsd(cents: number): string {
  const [whole, fraction] = (cents / 100).toFixed(2).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/**
 * Countries where Stripe offers Standard connected accounts, ISO 3166-1 alpha-2. Stripe's list
 * changes; check https://stripe.com/global before relying on a country at the edge of it. An artist
 * elsewhere is told Stripe isn't available there yet and pointed at Ko-fi, Patreon or Liberapay.
 */
export const STRIPE_CONNECT_COUNTRIES: Record<string, string> = {
  AU: 'Australia', AT: 'Austria', BE: 'Belgium', BR: 'Brazil', BG: 'Bulgaria', CA: 'Canada',
  HR: 'Croatia', CY: 'Cyprus', CZ: 'Czech Republic', DK: 'Denmark', EE: 'Estonia', FI: 'Finland',
  FR: 'France', DE: 'Germany', GI: 'Gibraltar', GR: 'Greece', HK: 'Hong Kong', HU: 'Hungary',
  IE: 'Ireland', IT: 'Italy', JP: 'Japan', LV: 'Latvia', LI: 'Liechtenstein', LT: 'Lithuania',
  LU: 'Luxembourg', MY: 'Malaysia', MT: 'Malta', MX: 'Mexico', NL: 'Netherlands', NZ: 'New Zealand',
  NO: 'Norway', PL: 'Poland', PT: 'Portugal', RO: 'Romania', SG: 'Singapore', SK: 'Slovakia',
  SI: 'Slovenia', ES: 'Spain', SE: 'Sweden', CH: 'Switzerland', TH: 'Thailand',
  AE: 'United Arab Emirates', GB: 'United Kingdom', US: 'United States',
};

export function isStripeConnectCountry(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(STRIPE_CONNECT_COUNTRIES, code);
}
