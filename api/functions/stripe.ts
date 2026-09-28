// A thin Stripe API client for artist tips (docs/specs/artist-patronage-spec.md §4).
//
// Plain fetch rather than the `stripe` package: every call here is a handful of form-encoded
// POSTs and GETs, and going through fetch keeps them behind the SSRF allowlist like every other
// outbound request (api.stripe.com is in ALLOWED_OUTBOUND_HOSTNAMES).
//
// Keys: STRIPE_SECRET_KEY is the platform's secret key. Test keys (sk_test_…) belong in every
// Netlify context except Production; `netlify dev` injects site-wide env into a laptop, so a
// site-wide live key would let local runs charge real cards. The mode is read from the key
// itself and stored with every row, so test and live data never mix (see the migration).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUrlHostnameAllowed } from './middleware';

const STRIPE_API = 'https://api.stripe.com';
/** Pinned so a Stripe-side default change can't alter behaviour under us. */
export const STRIPE_API_VERSION = '2025-03-31.basil';

export type StripeMode = 'test' | 'live';

/** The mode of the configured key, or null when tips are switched off (no key). */
export function stripeMode(): StripeMode | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return null;
}

/** livemode as stored in the tables: true only for a live key. */
export function isLiveMode(): boolean {
  return stripeMode() === 'live';
}

export class StripeError extends Error {
  readonly status: number;
  readonly type: string | undefined;
  readonly code: string | undefined;

  constructor(status: number, message: string, type?: string, code?: string) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/**
 * Stripe's form encoding: nested objects as `a[b][c]=v`, arrays as `a[0]=v`. Null and undefined
 * are omitted, so optional params can be written inline.
 */
export function encodeForm(params: Record<string, FormValue>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: FormValue) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return pairs.join('&');
}

export interface StripeRequestOptions {
  /** A connected account id: the request acts on the artist's account (direct charges). */
  stripeAccount?: string;
  idempotencyKey?: string;
}

/** One Stripe API call. Throws StripeError on any non-2xx, and on a missing key. */
export async function stripeRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, FormValue> = {},
  opts: StripeRequestOptions = {},
): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !stripeMode()) throw new StripeError(500, 'Stripe is not configured');

  const body = encodeForm(params);
  const url = method === 'GET' && body ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;
  if (!isUrlHostnameAllowed(url)) throw new StripeError(500, 'Stripe host not allowed');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Stripe-Version': STRIPE_API_VERSION,
  };
  if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({})) as { error?: { message?: string; type?: string; code?: string } };
  if (!res.ok) {
    throw new StripeError(res.status, json.error?.message ?? `Stripe ${res.status}`, json.error?.type, json.error?.code);
  }
  return json as T;
}

// ---------------------------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------------------------

/**
 * Verify a `Stripe-Signature` header against the raw request body, as Stripe's libraries do:
 * HMAC-SHA256 of `${t}.${body}` with the endpoint secret, compared in constant time against every
 * v1 signature in the header, with a timestamp tolerance against replays.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't') timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest();
  return signatures.some(sig => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ---------------------------------------------------------------------------------------------
// The objects this codebase reads. Only the fields used; Stripe sends many more.
// ---------------------------------------------------------------------------------------------

export interface StripeAccount {
  id: string;
  country?: string | null;
  charges_enabled?: boolean;
  details_submitted?: boolean;
  business_profile?: { name?: string | null; url?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
  email?: string | null;
}

export interface StripeAccountLink {
  url: string;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  payment_status?: string;
  payment_intent?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  livemode?: boolean;
  metadata?: Record<string, string> | null;
}

export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  /** Set on Connect events: the connected account the event happened on. */
  account?: string;
  data: { object: Record<string, unknown> };
}
