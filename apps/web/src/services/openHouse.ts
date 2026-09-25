// Data and arithmetic for the /open-house page.
//
// Two sources, deliberately kept apart so they can't be confused on the page:
// - data/open-house/ledger.json — costs and closed months, edited by hand once a month.
// - /api/open-house — live membership aggregates from the webhook-maintained table, CDN-cached
//   for an hour.
// Spec: docs/specs/open-house-membership-spec.md §5.

export interface LedgerCost {
  item: string;
  /** USD per month. Yearly costs are divided by twelve. */
  monthly: number;
  /** False while Unstream is still on that service's free tier. */
  paying: boolean;
  why: string;
}

export interface LedgerMonth {
  /** YYYY-MM */
  month: string;
  costs: number;
  processingFees: number;
  memberRevenue: number;
  tipFeeRevenue: number;
  otherRevenue: number;
}

export interface Ledger {
  /** True until Brandon has checked every figure against a real invoice. */
  draft: boolean;
  updated: string;
  currency: string;
  costs: LedgerCost[];
  months: LedgerMonth[];
}

export interface OpenHouseLive {
  activeMembers: number | null;
  monthlyRecurringCents: number | null;
  byPlan: Record<'monthly' | 'annual' | 'lifetime' | 'grandfathered', number> | null;
  belowThreshold: boolean;
  generatedAt: string;
}

export async function fetchLedger(): Promise<Ledger> {
  const res = await fetch('/data/open-house/ledger.json');
  if (!res.ok) throw new Error(`ledger ${res.status}`);
  return (await res.json()) as Ledger;
}

export async function fetchLive(): Promise<OpenHouseLive> {
  const res = await fetch('/api/open-house');
  if (!res.ok) throw new Error(`open-house ${res.status}`);
  return (await res.json()) as OpenHouseLive;
}

export interface CostTotals {
  /** What Unstream pays today. */
  current: number;
  /** What it would pay off every free tier on the list. */
  full: number;
}

export function costTotals(costs: LedgerCost[]): CostTotals {
  let current = 0;
  let full = 0;
  for (const cost of costs) {
    full += cost.monthly;
    if (cost.paying) current += cost.monthly;
  }
  return { current: round2(current), full: round2(full) };
}

/**
 * Members' monthly revenue as a whole percentage of a monthly cost, or null when there's
 * nothing to show (counts withheld below the threshold, or no cost to cover).
 */
export function coveragePercent(monthlyRecurringCents: number | null, monthlyCost: number): number | null {
  if (monthlyRecurringCents === null || monthlyCost <= 0) return null;
  return Math.round((monthlyRecurringCents / 100 / monthlyCost) * 100);
}

export function formatUsd(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Membership actions (signed in)
// ---------------------------------------------------------------------------

export type PurchasablePlan = 'monthly' | 'annual' | 'lifetime';

export interface MyMembership {
  active: boolean;
  plan: 'monthly' | 'annual' | 'lifetime' | 'grandfathered' | null;
  status: 'active' | 'past_due' | 'canceled' | null;
  currentPeriodEnd: string | null;
  canManage: boolean;
}

export async function fetchMyMembership(accessToken: string): Promise<MyMembership> {
  const res = await fetch('/api/me/membership', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`me/membership ${res.status}`);
  return (await res.json()) as MyMembership;
}

/** Returns the hosted Stripe URL to send the browser to. Throws with the server's message. */
async function postForUrl(path: string, accessToken: string, body?: unknown): Promise<string> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.error || 'Something went wrong');
  return data.url;
}

export function startCheckout(accessToken: string, plan: PurchasablePlan): Promise<string> {
  return postForUrl('/api/membership/checkout', accessToken, { plan });
}

export function openMembershipPortal(accessToken: string): Promise<string> {
  return postForUrl('/api/membership/portal', accessToken);
}
