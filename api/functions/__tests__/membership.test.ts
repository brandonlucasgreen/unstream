import { describe, it, expect } from 'vitest';
import {
  GRACE_DAYS,
  MIN_PUBLIC_MEMBER_COUNT,
  isMembershipActive,
  isPurchasablePlan,
  rowFromLifetimePurchase,
  rowFromSubscription,
  summariseMemberships,
  type MembershipRow,
  type SubscriptionSnapshot,
} from '../membership';

const NOW = new Date('2026-10-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    user_id: 'user-1',
    plan: 'monthly',
    status: 'active',
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    amount_cents: 300,
    currency: 'usd',
    current_period_end: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    canceled_at: null,
    ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    id: 'sub_1',
    customerId: 'cus_1',
    status: 'active',
    currentPeriodEnd: Math.floor((NOW.getTime() + 30 * DAY) / 1000),
    interval: 'month',
    unitAmount: 300,
    currency: 'usd',
    canceledAt: null,
    ...overrides,
  };
}

describe('isPurchasablePlan', () => {
  it('accepts the three plans a person can buy and nothing else', () => {
    expect(isPurchasablePlan('monthly')).toBe(true);
    expect(isPurchasablePlan('annual')).toBe(true);
    expect(isPurchasablePlan('lifetime')).toBe(true);
    // Granted by hand only — buying it through checkout would be a free membership.
    expect(isPurchasablePlan('grandfathered')).toBe(false);
    expect(isPurchasablePlan(undefined)).toBe(false);
    expect(isPurchasablePlan({})).toBe(false);
  });
});

describe('isMembershipActive', () => {
  it('is false with no row or a canceled row', () => {
    expect(isMembershipActive(null, NOW)).toBe(false);
    expect(isMembershipActive(row({ status: 'canceled' }), NOW)).toBe(false);
  });

  it('is true for rows that never expire', () => {
    expect(isMembershipActive(row({ plan: 'lifetime', current_period_end: null }), NOW)).toBe(true);
    expect(isMembershipActive(row({ plan: 'grandfathered', current_period_end: null }), NOW)).toBe(true);
  });

  it('keeps perks through the grace period, then fails closed', () => {
    const lapsed = (days: number) =>
      row({ status: 'past_due', current_period_end: new Date(NOW.getTime() - days * DAY).toISOString() });
    expect(isMembershipActive(lapsed(GRACE_DAYS - 1), NOW)).toBe(true);
    expect(isMembershipActive(lapsed(GRACE_DAYS + 1), NOW)).toBe(false);
  });

  it('fails closed on an "active" row whose period ended long ago (missed webhook)', () => {
    const stale = row({ current_period_end: new Date(NOW.getTime() - 60 * DAY).toISOString() });
    expect(isMembershipActive(stale, NOW)).toBe(false);
  });
});

describe('rowFromSubscription', () => {
  it('maps an active monthly subscription', () => {
    const result = rowFromSubscription('user-1', sub(), null);
    expect(result).toMatchObject({
      user_id: 'user-1',
      plan: 'monthly',
      status: 'active',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      amount_cents: 300,
      canceled_at: null,
    });
    expect(result?.current_period_end).toBe(new Date((sub().currentPeriodEnd as number) * 1000).toISOString());
  });

  it('maps a yearly price to the annual plan', () => {
    expect(rowFromSubscription('user-1', sub({ interval: 'year', unitAmount: 2500 }), null)?.plan).toBe('annual');
  });

  it('maps past_due and unpaid to past_due, and an unpaid first attempt to canceled', () => {
    expect(rowFromSubscription('user-1', sub({ status: 'past_due' }), null)?.status).toBe('past_due');
    expect(rowFromSubscription('user-1', sub({ status: 'unpaid' }), null)?.status).toBe('past_due');
    // `incomplete` means the first payment never went through: no perks.
    expect(rowFromSubscription('user-1', sub({ status: 'incomplete' }), null)?.status).toBe('canceled');
    expect(rowFromSubscription('user-1', sub({ status: 'something_new' }), null)?.status).toBe('canceled');
  });

  it('never touches a lifetime member', () => {
    const lifetime = row({ plan: 'lifetime', stripe_subscription_id: null, current_period_end: null });
    expect(rowFromSubscription('user-1', sub({ status: 'canceled' }), lifetime)).toBeNull();
    expect(rowFromSubscription('user-1', sub({ status: 'active' }), lifetime)).toBeNull();
  });

  it('ignores the cancellation of a subscription that is no longer the current one', () => {
    const current = row({ stripe_subscription_id: 'sub_new' });
    expect(rowFromSubscription('user-1', sub({ id: 'sub_old', status: 'canceled' }), current)).toBeNull();
  });

  it('applies the cancellation of the current subscription', () => {
    const result = rowFromSubscription('user-1', sub({ status: 'canceled', canceledAt: 1790000000 }), row());
    expect(result?.status).toBe('canceled');
    expect(result?.canceled_at).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it('upgrades a grandfathered member who starts paying, and keeps them if it ends', () => {
    const grandfathered = row({
      plan: 'grandfathered',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      current_period_end: null,
    });
    expect(rowFromSubscription('user-1', sub(), grandfathered)?.plan).toBe('monthly');
    expect(rowFromSubscription('user-1', sub({ status: 'canceled' }), grandfathered)).toBeNull();
  });
});

describe('rowFromLifetimePurchase', () => {
  it('is active and never expires', () => {
    const result = rowFromLifetimePurchase('user-1', 'cus_1', 10000, 'usd');
    expect(result).toMatchObject({ plan: 'lifetime', status: 'active', current_period_end: null });
    expect(isMembershipActive(result, NOW)).toBe(true);
  });
});

describe('summariseMemberships', () => {
  it('withholds everything below the public threshold', () => {
    const rows = Array.from({ length: MIN_PUBLIC_MEMBER_COUNT - 1 }, (_, i) => row({ user_id: `u${i}` }));
    expect(summariseMemberships(rows, NOW)).toEqual({
      activeMembers: null,
      monthlyRecurringCents: null,
      byPlan: null,
      belowThreshold: true,
    });
  });

  it('counts only active rows toward the threshold', () => {
    const rows = [
      ...Array.from({ length: MIN_PUBLIC_MEMBER_COUNT - 1 }, (_, i) => row({ user_id: `u${i}` })),
      row({ user_id: 'lapsed', status: 'past_due', current_period_end: new Date(NOW.getTime() - 30 * DAY).toISOString() }),
    ];
    expect(summariseMemberships(rows, NOW).belowThreshold).toBe(true);
  });

  it('normalises annual to monthly and leaves lifetime and grandfathered out of recurring revenue', () => {
    const rows = [
      row({ user_id: 'a', plan: 'monthly', amount_cents: 300 }),
      row({ user_id: 'b', plan: 'monthly', amount_cents: 300 }),
      row({ user_id: 'c', plan: 'annual', amount_cents: 2500 }),
      row({ user_id: 'd', plan: 'lifetime', amount_cents: 10000, current_period_end: null }),
      row({ user_id: 'e', plan: 'grandfathered', amount_cents: null, current_period_end: null }),
    ];
    expect(summariseMemberships(rows, NOW)).toEqual({
      activeMembers: 5,
      monthlyRecurringCents: 300 + 300 + Math.round(2500 / 12),
      byPlan: { monthly: 2, annual: 1, lifetime: 1, grandfathered: 1 },
      belowThreshold: false,
    });
  });

  it('counts a non-USD member but does not add their amount to a USD total', () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => row({ user_id: `u${i}` })),
      row({ user_id: 'eur', currency: 'eur', amount_cents: 300 }),
    ];
    const summary = summariseMemberships(rows, NOW);
    expect(summary.activeMembers).toBe(5);
    expect(summary.monthlyRecurringCents).toBe(4 * 300);
  });
});
