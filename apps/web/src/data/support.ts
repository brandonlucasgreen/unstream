// What /support shows: what Unstream is about to cost, and the three ways to chip in.
// Spec: docs/specs/support-page-spec.md.
//
// The payment options are Stripe Payment Links, made in the Stripe dashboard and pasted in
// here. They're public URLs, not secrets, so they live in code rather than env. An option with
// no link yet shows as "Not live yet", and until all three have one the Liberapay button stays
// as the working way to give, so merging this before Stripe is set up can't leave /support
// with nothing to click.

export interface SupportOption {
  id: 'monthly' | 'yearly' | 'one-off';
  label: string;
  price: string;
  note: string;
  /** A https://buy.stripe.com/... Payment Link, or null until it exists. */
  url: string | null;
}

export const SUPPORT_OPTIONS: SupportOption[] = [
  { id: 'monthly', label: 'Monthly', price: '$3 a month', note: 'Cancel any time.', url: null },
  { id: 'yearly', label: 'Yearly', price: '$25 a year', note: 'Less of it goes to card fees.', url: null },
  { id: 'one-off', label: 'One-off', price: 'Pay what you want', note: 'Once, any amount from $3.', url: null },
];

/**
 * Stripe's hosted customer portal login page, where recurring supporters cancel or update
 * their card by email. Null until it's switched on in the Stripe dashboard.
 */
export const MANAGE_SUPPORT_URL: string | null = null;

export const LIBERAPAY_URL = 'https://liberapay.com/brandonlucasgreen';

/** True once every option has a Payment Link, i.e. Stripe is live. */
export function stripeSupportReady(options: SupportOption[] = SUPPORT_OPTIONS): boolean {
  return options.every((option) => option.url !== null);
}

export interface UpcomingCost {
  service: string;
  what: string;
  /** Rough monthly cost once on the paid tier. */
  monthly: string;
}

/**
 * The free tiers Unstream is outgrowing. Rough figures, stated as such on the page; check them
 * against real invoices before changing the copy around them. (The Apple Developer Program is
 * already paid, and the page says so separately.)
 */
export const UPCOMING_COSTS: UpcomingCost[] = [
  { service: 'Supabase', what: 'the database', monthly: '~$25–30' },
  { service: 'Netlify', what: 'hosting and builds', monthly: '~$9–20' },
  { service: 'Upstash', what: 'caching and rate limits', monthly: 'a few dollars' },
];
