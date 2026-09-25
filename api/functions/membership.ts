// Open Studio membership state: the rules for "is this user a member?", the mapping from Stripe
// objects to a `memberships` row, and the table's reads and writes.
//
// Spec: docs/specs/open-studio-membership-spec.md §8. The table is server-only (RLS on, no
// policies), so everything here runs through the service-role client.
//
// The mapping functions are pure and take plain shapes rather than Stripe types, so the rules
// that decide who has perks are unit-testable without mocking the SDK.

import { getClient } from './db';

export type MembershipPlan = 'monthly' | 'annual' | 'lifetime' | 'grandfathered';
export type MembershipStatus = 'active' | 'past_due' | 'canceled';

/** The plans a person can buy. `grandfathered` is only ever granted by hand. */
export const PURCHASABLE_PLANS = ['monthly', 'annual', 'lifetime'] as const;
export type PurchasablePlan = (typeof PURCHASABLE_PLANS)[number];

export function isPurchasablePlan(value: unknown): value is PurchasablePlan {
  return typeof value === 'string' && (PURCHASABLE_PLANS as readonly string[]).includes(value);
}

export interface MembershipRow {
  user_id: string;
  plan: MembershipPlan;
  status: MembershipStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
}

/**
 * How long perks survive past the paid-up date. Stripe retries a failed card over several days
 * and a renewal can land a little after the period rolls over; a lapsed card shouldn't lose a
 * member their badge on day one.
 */
export const GRACE_DAYS = 7;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Whether a row confers membership right now.
 *
 * Checks the date as well as the status, so a missed `customer.subscription.deleted` webhook
 * fails closed once the grace period runs out instead of leaving someone a member forever.
 */
export function isMembershipActive(row: MembershipRow | null, now: Date = new Date()): boolean {
  if (!row || row.status === 'canceled') return false;
  if (row.current_period_end === null) return true; // lifetime, grandfathered
  return new Date(row.current_period_end).getTime() + GRACE_MS > now.getTime();
}

/** The subset of a Stripe subscription the mapping needs. */
export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: string;
  /** Unix seconds — from the subscription item, where current Stripe API versions put it. */
  currentPeriodEnd: number | null;
  /** The recurring price's interval: 'month' or 'year'. */
  interval: string | null;
  unitAmount: number | null;
  currency: string | null;
  canceledAt: number | null;
}

function toMembershipStatus(stripeStatus: string): MembershipStatus {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      // Paid before, renewal failing: perks continue through the grace period.
      return 'past_due';
    default:
      // canceled, incomplete (the first payment never went through), incomplete_expired,
      // paused, and anything Stripe adds later. Unknown means no perks: an unrecognised state
      // is not a reason to keep granting them.
      return 'canceled';
  }
}

function isoFromUnix(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

/**
 * The row a subscription implies for this user, or null to leave the existing row alone.
 *
 * The rules that make replays and stale events harmless:
 * - A lifetime member is never touched by subscription events. Someone who had a monthly plan
 *   and then bought lifetime will see the old subscription's cancellation arrive later.
 * - A cancellation of a subscription that isn't the row's current one is stale, and ignored.
 * - A grandfathered member who starts paying becomes a paying member; their subscription
 *   ending later doesn't take the grandfathered perks away, because the row was theirs first.
 */
export function rowFromSubscription(
  userId: string,
  sub: SubscriptionSnapshot,
  existing: MembershipRow | null
): MembershipRow | null {
  const status = toMembershipStatus(sub.status);

  if (existing?.plan === 'lifetime') return null;
  if (status === 'canceled') {
    if (existing?.plan === 'grandfathered') return null;
    if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== sub.id) return null;
  }

  return {
    user_id: userId,
    plan: sub.interval === 'year' ? 'annual' : 'monthly',
    status,
    stripe_customer_id: sub.customerId,
    stripe_subscription_id: sub.id,
    amount_cents: sub.unitAmount,
    currency: sub.currency,
    current_period_end: isoFromUnix(sub.currentPeriodEnd),
    canceled_at: status === 'canceled' ? isoFromUnix(sub.canceledAt) ?? new Date().toISOString() : null,
  };
}

/** A completed one-off lifetime purchase always wins: it's the most a member can give. */
export function rowFromLifetimePurchase(
  userId: string,
  customerId: string | null,
  amountCents: number | null,
  currency: string | null
): MembershipRow {
  return {
    user_id: userId,
    plan: 'lifetime',
    status: 'active',
    stripe_customer_id: customerId,
    stripe_subscription_id: null,
    amount_cents: amountCents,
    currency,
    current_period_end: null,
    canceled_at: null,
  };
}

// ---------------------------------------------------------------------------
// Aggregates for /open-studio
// ---------------------------------------------------------------------------

/**
 * Below this many members the page shows "fewer than 5" and no revenue, so one person's
 * payment can't be read off the total.
 */
export const MIN_PUBLIC_MEMBER_COUNT = 5;

export interface OpenStudioLive {
  /** Null when there are fewer than MIN_PUBLIC_MEMBER_COUNT members. */
  activeMembers: number | null;
  /** Recurring revenue normalised to a month (annual ÷ 12), in USD cents. Null below the threshold. */
  monthlyRecurringCents: number | null;
  /** Null below the threshold, for the same reason. */
  byPlan: Record<MembershipPlan, number> | null;
  belowThreshold: boolean;
}

/**
 * Aggregate live rows into what the public page may show.
 *
 * Lifetime and grandfathered members count as members but add nothing to monthly recurring
 * revenue: lifetime money is shown in the month it arrived, in the hand-closed ledger, rather
 * than amortised into a number that would imply it recurs. Non-USD rows are counted but not
 * summed — prices are set in USD and a mixed-currency total would be wrong silently.
 */
export function summariseMemberships(rows: MembershipRow[], now: Date = new Date()): OpenStudioLive {
  const active = rows.filter((row) => isMembershipActive(row, now));
  if (active.length < MIN_PUBLIC_MEMBER_COUNT) {
    return { activeMembers: null, monthlyRecurringCents: null, byPlan: null, belowThreshold: true };
  }

  const byPlan: Record<MembershipPlan, number> = { monthly: 0, annual: 0, lifetime: 0, grandfathered: 0 };
  let monthlyRecurringCents = 0;
  for (const row of active) {
    byPlan[row.plan] += 1;
    if (row.amount_cents === null || row.currency?.toLowerCase() !== 'usd') continue;
    if (row.plan === 'monthly') monthlyRecurringCents += row.amount_cents;
    if (row.plan === 'annual') monthlyRecurringCents += Math.round(row.amount_cents / 12);
  }

  return { activeMembers: active.length, monthlyRecurringCents, byPlan, belowThreshold: false };
}

// ---------------------------------------------------------------------------
// Table access (service role)
// ---------------------------------------------------------------------------

const COLUMNS =
  'user_id, plan, status, stripe_customer_id, stripe_subscription_id, amount_cents, currency, current_period_end, canceled_at';

/**
 * The user's row, or null if they have none. Throws on a database error rather than returning
 * null: "couldn't read" must not look like "not a member", or a blip would let someone buy a
 * second membership and would hide perks from people who paid.
 */
export async function getMembership(userId: string): Promise<MembershipRow | null> {
  const client = getClient();
  if (!client) throw new Error('Database not configured');

  const { data, error } = await client.from('memberships').select(COLUMNS).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`getMembership failed: ${error.message}`);
  return (data as MembershipRow | null) ?? null;
}

/** The user who owns a Stripe customer, for events that carry no user id of their own. */
export async function getUserIdForCustomer(customerId: string): Promise<string | null> {
  const client = getClient();
  if (!client) throw new Error('Database not configured');

  const { data, error } = await client
    .from('memberships')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) throw new Error(`getUserIdForCustomer failed: ${error.message}`);
  return data ? (data as { user_id: string }).user_id : null;
}

export async function upsertMembership(row: MembershipRow): Promise<void> {
  const client = getClient();
  if (!client) throw new Error('Database not configured');

  const { error } = await client.from('memberships').upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error(`upsertMembership failed: ${error.message}`);
}

/**
 * Every non-canceled row. The table holds one row per member, so this stays far below
 * PostgREST's silent 1,000-row cap for as long as Unstream is a side project — and the
 * function refuses to report a truncated count if that ever stops being true.
 */
export async function listLiveMemberships(): Promise<MembershipRow[]> {
  const client = getClient();
  if (!client) throw new Error('Database not configured');

  const { data, error } = await client.from('memberships').select(COLUMNS).neq('status', 'canceled').range(0, 999);
  if (error) throw new Error(`listLiveMemberships failed: ${error.message}`);
  const rows = (data as MembershipRow[] | null) ?? [];
  if (rows.length >= 1000) {
    throw new Error('listLiveMemberships hit the 1,000-row page; switch to readAllPages');
  }
  return rows;
}
