// The one place a Stripe client is constructed.
//
// The Stripe SDK does its own networking, so on its own it would be the one outbound path in
// api/ that skips ALLOWED_OUTBOUND_HOSTNAMES. It's built with a fetch that refuses any host
// the allowlist doesn't hold, which in practice means api.stripe.com and nothing else.
//
// Keys: STRIPE_SECRET_KEY should be a *restricted* key with only the permissions the
// membership functions use (Checkout Sessions write, Billing Portal write, Subscriptions
// read). Test-mode keys locally, live keys only in the Netlify production context —
// `npm run dev` talks to production Supabase, so a live key there would write real rows.

import Stripe from 'stripe';
import { isUrlHostnameAllowed } from './middleware';
import type { PurchasablePlan } from './membership';

let stripe: Stripe | null = null;

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const allowlistedFetch: typeof fetch = (input, init) => {
  const url = requestUrl(input);
  if (!isUrlHostnameAllowed(url)) {
    return Promise.reject(new Error(`Stripe request to a host outside the allowlist: ${new URL(url).hostname}`));
  }
  return fetch(input, init);
};

/** The shared client, or null when STRIPE_SECRET_KEY isn't set. */
export function getStripe(): Stripe | null {
  if (stripe) return stripe;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;

  stripe = new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(allowlistedFetch),
    // One retry covers a dropped connection; Stripe's idempotency makes it safe for creates.
    maxNetworkRetries: 1,
    timeout: 10_000,
  });
  return stripe;
}

/**
 * The Stripe Price id for a plan, from env (STRIPE_PRICE_MONTHLY / _ANNUAL / _LIFETIME), or
 * null if unset. Prices live in the Stripe dashboard so changing one needs no deploy; the
 * amounts are $3 / $25 / $100 (spec §4).
 */
export function priceIdForPlan(plan: PurchasablePlan): string | null {
  const envName = {
    monthly: 'STRIPE_PRICE_MONTHLY',
    annual: 'STRIPE_PRICE_ANNUAL',
    lifetime: 'STRIPE_PRICE_LIFETIME',
  }[plan];
  return process.env[envName] || null;
}

/**
 * Where Checkout and the Customer Portal send people back to. Netlify sets URL to the site's
 * primary address in production and to the local server under `netlify dev`; it's one of the
 * few build variables that exists at function runtime (CLAUDE.md, "Testing release ingest").
 */
export function siteUrl(): string {
  return process.env.URL || 'https://unstream.stream';
}
