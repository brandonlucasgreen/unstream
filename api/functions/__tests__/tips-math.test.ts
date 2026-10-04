// The money arithmetic behind every tip (docs/specs/artist-patronage-spec.md §5). The fee table
// below is the spec's, as fixtures: if Stripe's standard pricing changes, this is where it shows.

import { describe, it, expect } from 'vitest';
import {
  ONE_OFF_MAX_CENTS,
  ONE_OFF_MIN_CENTS,
  canChargeApplicationFee,
  estimatedStripeFeeCents,
  formatUsd,
  isStripeConnectCountry,
  isValidFeeBasisPoints,
  isValidOneOffAmount,
  keptAfterRefund,
  tipBreakdown,
} from '../../shared/tips';

describe('Stripe fee estimate (spec §5 table)', () => {
  it.each([
    [100, 33],
    [300, 39],
    [500, 45],
    [1000, 59],
    [2000, 88],
  ])('a %i¢ charge costs %i¢', (charge, fee) => {
    expect(estimatedStripeFeeCents(charge)).toBe(fee);
  });
});

describe('tipBreakdown', () => {
  it('reproduces the spec’s example: $5 with fees covered, no Unstream fee', () => {
    // "You pay $5.46 · Stripe keeps $0.46 · Unstream keeps $0 · {Artist} gets $5.00."
    expect(tipBreakdown(500, true, 0)).toEqual({
      amountCents: 500,
      grossCents: 546,
      stripeFeeCents: 46,
      applicationFeeCents: 0,
      artistNetCents: 500,
    });
  });

  it('never leaves the artist short when covering fees, across amounts and fees', () => {
    for (const amount of [300, 500, 777, 1000, 2000, 5000, 50000]) {
      for (const bps of [0, 100, 250, 500]) {
        const b = tipBreakdown(amount, true, bps);
        expect(b.artistNetCents).toBeGreaterThanOrEqual(amount);
        expect(b.artistNetCents - amount).toBeLessThanOrEqual(2); // rounding, not a windfall
        expect(b.grossCents).toBe(b.stripeFeeCents + b.applicationFeeCents + b.artistNetCents);
      }
    }
  });

  it('charges exactly the amount when fees are not covered', () => {
    const b = tipBreakdown(1000, false, 0);
    expect(b.grossCents).toBe(1000);
    expect(b.artistNetCents).toBe(1000 - 59);
  });

  it('takes the Unstream fee as a share of what the fan pays', () => {
    const b = tipBreakdown(1000, false, 500);
    expect(b.applicationFeeCents).toBe(50);
    expect(b.artistNetCents).toBe(1000 - 59 - 50);
  });
});

describe('bounds', () => {
  it('accepts whole cents from $3 to $500 only', () => {
    expect(isValidOneOffAmount(ONE_OFF_MIN_CENTS)).toBe(true);
    expect(isValidOneOffAmount(ONE_OFF_MAX_CENTS)).toBe(true);
    expect(isValidOneOffAmount(299)).toBe(false);
    expect(isValidOneOffAmount(50001)).toBe(false);
    expect(isValidOneOffAmount(500.5)).toBe(false);
    expect(isValidOneOffAmount('500')).toBe(false);
    expect(isValidOneOffAmount(-500)).toBe(false);
  });

  it('accepts an Unstream fee of 0–5% in whole basis points', () => {
    expect(isValidFeeBasisPoints(0)).toBe(true);
    expect(isValidFeeBasisPoints(500)).toBe(true);
    expect(isValidFeeBasisPoints(501)).toBe(false);
    expect(isValidFeeBasisPoints(-1)).toBe(false);
    expect(isValidFeeBasisPoints(2.5)).toBe(false);
  });

  it('knows which countries Stripe supports', () => {
    expect(isStripeConnectCountry('US')).toBe(true);
    expect(isStripeConnectCountry('GB')).toBe(true);
    expect(isStripeConnectCountry('NG')).toBe(false);
    expect(isStripeConnectCountry('toString')).toBe(false);
  });

  it('formats dollars', () => {
    expect(formatUsd(546)).toBe('$5.46');
    expect(formatUsd(240000)).toBe('$2,400.00');
    expect(formatUsd(10000000)).toBe('$100,000.00');
  });
});

describe('keptAfterRefund (what a partly refunded tip still counts for)', () => {
  it('takes off the refunded share in proportion, matching the fee return in tips-webhook', () => {
    expect(keptAfterRefund(500, 546, 0)).toBe(500);
    expect(keptAfterRefund(500, 546, 273)).toBe(250);
    expect(keptAfterRefund(29, 576, 288)).toBe(14); // the fee: 29 − round(14.5)
    expect(keptAfterRefund(500, 546, 546)).toBe(0);
    expect(keptAfterRefund(500, 546, 600)).toBe(0);
  });
});

describe('canChargeApplicationFee', () => {
  it('is false only where Stripe forbids a platform fee on direct charges', () => {
    for (const c of ['BR', 'MY', 'TH', 'br']) expect(canChargeApplicationFee(c)).toBe(false);
    for (const c of ['US', 'GB', 'JP', null, undefined]) expect(canChargeApplicationFee(c)).toBe(true);
  });
});
