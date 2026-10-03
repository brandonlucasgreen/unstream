// Client for the artist side of tips: /api/tips/settings and /api/tips/connect.

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
  goals: TipGoal[];
  totals: { month: TipTotals; allTime: TipTotals } | null;
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new TipsApiError((body as { error?: string }).error ?? `HTTP ${r.status}`, r.status);
  return body as T;
}

export class TipsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
