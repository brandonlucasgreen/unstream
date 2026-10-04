// Client for tips: the artist side (/api/tips/settings, /api/tips/connect), the tip page
// (/api/tips/checkout) and a fan's own record (/api/me/tips).

import type { TipGoal } from '../types/artist-page';

export type TipsState =
  | 'not_connected'
  | 'onboarding'
  | 'stripe_review'
  | 'stripe_declined'
  | 'awaiting_approval'
  | 'connected';

export interface TipTotals {
  count: number;
  grossCents: number;
  netCents: number;
  applicationFeeCents: number;
}

export interface TipSettings {
  available: boolean;
  artistName: string;
  livemode: boolean;
  state: TipsState;
  foreignAccount: boolean;
  tipsEnabled: boolean;
  feeBasisPoints: number;
  country: string | null;
  countries: Record<string, string>;
  /**
   * False when Stripe won't take an application fee for the account's country (Brazil, Malaysia,
   * Thailand), so Unstream's share is fixed at 0%. Missing means allowed.
   */
  feeAllowed?: boolean;
  goals: TipGoal[];
  totals: { month: TipTotals; allTime: TipTotals } | null;
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const { error, code } = body as { error?: string; code?: string };
    throw new TipsApiError(error ?? `HTTP ${r.status}`, r.status, code);
  }
  return body as T;
}

export class TipsApiError extends Error {
  readonly status: number;
  /** A machine-readable reason, when the server gives one — e.g. 'stripe_rejected' from /api/tips/connect. */
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Whether the server takes tips at all (it has a Stripe key) — decides if the Manage Tips tab shows. */
export async function getTipsAvailable(token: string): Promise<boolean> {
  const { available } = await call<{ available: boolean }>(token, '/api/tips/settings?summary=1');
  return available;
}

export function getTipSettings(token: string, slug: string): Promise<TipSettings> {
  return call(token, `/api/tips/settings?slug=${encodeURIComponent(slug)}`);
}

export function updateTipSettings(token: string, slug: string, patch: { tipsEnabled?: boolean; feeBasisPoints?: number }): Promise<TipSettings> {
  return call(token, '/api/tips/settings', { method: 'PUT', body: JSON.stringify({ slug, action: 'update', ...patch }) });
}

export function createGoal(token: string, slug: string, goal: { title: string; targetCents: number }): Promise<{ goals: TipGoal[] }> {
  return call(token, '/api/tips/settings', { method: 'PUT', body: JSON.stringify({ slug, action: 'createGoal', ...goal }) });
}

export function closeGoal(token: string, slug: string, goalId: string): Promise<{ goals: TipGoal[] }> {
  return call(token, '/api/tips/settings', { method: 'PUT', body: JSON.stringify({ slug, action: 'closeGoal', goalId }) });
}

/** Start or resume Stripe onboarding; resolves to the Stripe-hosted URL to send the artist to. */
export async function connectStripe(token: string, slug: string, opts: { country?: string; acceptAddendum?: boolean }): Promise<string> {
  const { url } = await call<{ url: string }>(token, '/api/tips/connect', { method: 'POST', body: JSON.stringify({ slug, ...opts }) });
  return url;
}

// ---------------------------------------------------------------------------------------------
// The fan's side: what the tip page and the tip window show before sending them to Stripe.
// ---------------------------------------------------------------------------------------------

export interface TipPageData {
  artist: { id: string; slug: string; name: string; imageUrl: string | null };
  takingTips: boolean;
  feeBasisPoints?: number;
  goals?: TipGoal[];
  presetsCents?: number[];
  minCents?: number;
  maxCents?: number;
}

/** GET /api/tips/checkout?slug= — public. Throws TipsApiError, with the status (404: no such artist). */
export async function getTipPage(slug: string): Promise<TipPageData> {
  const r = await fetch(`/api/tips/checkout?slug=${encodeURIComponent(slug)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new TipsApiError((body as { error?: string }).error ?? `HTTP ${r.status}`, r.status);
  return body as TipPageData;
}

// ---------------------------------------------------------------------------------------------
// A fan's own record: /api/me/tips.
// ---------------------------------------------------------------------------------------------

export interface FanTip {
  id: string;
  artistName: string;
  artistSlug: string;
  /** What the fan chose to give the artist. */
  amountCents: number;
  /** What the fan paid, including any fees they covered. */
  paidCents: number;
  /** How much of paidCents the artist has refunded; non-zero on a partial refund too. */
  refundedCents: number;
  currency: string;
  status: 'succeeded' | 'refunded' | 'disputed';
  goalTitle: string | null;
  createdAt: string;
}

export async function getMyTips(token: string): Promise<FanTip[]> {
  const { tips } = await call<{ tips: FanTip[] }>(token, '/api/me/tips');
  return tips;
}

/**
 * Save a tip paid while signed out to this account, from the Checkout Session id Stripe put in the
 * /tip/thanks URL. 'pending' means Stripe has the payment but Unstream hasn't recorded it yet, so
 * the caller should try again shortly. Throws TipsApiError otherwise (404, 409 someone else's, 410
 * too old).
 */
export async function claimTip(token: string, sessionId: string, artistSlug: string): Promise<'saved' | 'pending'> {
  const { status } = await call<{ status: 'saved' | 'pending' }>(token, '/api/me/tips', {
    method: 'POST',
    body: JSON.stringify({ sessionId, artistSlug }),
  });
  return status;
}
