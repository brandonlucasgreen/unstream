import { describe, it, expect } from 'vitest';
import { MANAGE_SUPPORT_URL, SUPPORT_OPTIONS, stripeSupportReady, type SupportOption } from '../../src/data/support';

const withUrls = (urls: (string | null)[]): SupportOption[] =>
  SUPPORT_OPTIONS.map((option, i) => ({ ...option, url: urls[i] }));

describe('stripeSupportReady', () => {
  it('is false until every option has a Payment Link, so Liberapay stays the way to give', () => {
    expect(stripeSupportReady(withUrls([null, null, null]))).toBe(false);
    expect(stripeSupportReady(withUrls(['https://buy.stripe.com/a', 'https://buy.stripe.com/b', null]))).toBe(false);
  });

  it('is true once all three are filled in', () => {
    expect(
      stripeSupportReady(withUrls(['https://buy.stripe.com/a', 'https://buy.stripe.com/b', 'https://buy.stripe.com/c']))
    ).toBe(true);
  });
});

describe('SUPPORT_OPTIONS', () => {
  it('offers monthly, yearly and a one-off, in that order', () => {
    expect(SUPPORT_OPTIONS.map((option) => option.id)).toEqual(['monthly', 'yearly', 'one-off']);
  });

  // Hosted Stripe pages are top-level navigations, which is why the CSP needs no change. A link
  // to any other host would be a typo at best, so pin it.
  it('only ever links to Stripe-hosted pages', () => {
    for (const option of SUPPORT_OPTIONS) {
      if (option.url !== null) expect(new URL(option.url).hostname).toBe('buy.stripe.com');
    }
    if (MANAGE_SUPPORT_URL !== null) expect(new URL(MANAGE_SUPPORT_URL).hostname).toBe('billing.stripe.com');
  });
});
