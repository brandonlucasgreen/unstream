// What /support shows: what Unstream is about to cost, and where to chip in.
// Spec: docs/specs/support-page-spec.md.
//
// Contributions go through Brandon's Ko-fi page, which handles one-off and monthly support,
// receipts and cancellations, and takes no cut of tips. Nothing about it lives in Unstream's
// backend: /support just links there.

export const KOFI_URL = 'https://ko-fi.com/bgreenlol';

export interface UpcomingCost {
  service: string;
  what: string;
  /** Rough monthly cost once on the paid tier. */
  monthly: string;
}

/**
 * What running Unstream costs once it's off the free tiers, plus the Apple membership it
 * already pays for. Rough figures, stated as such on the page; check them against real
 * invoices before changing the copy around them. Netlify is left out on purpose: that cost is
 * managed by deploying less.
 */
export const UPCOMING_COSTS: UpcomingCost[] = [
  { service: 'Supabase', what: 'the database', monthly: '~$25–30' },
  { service: 'Upstash', what: 'caching and rate limits', monthly: 'a few dollars' },
  { service: 'Apple Developer Program', what: 'signing the Mac and iOS apps', monthly: '~$8' },
];
