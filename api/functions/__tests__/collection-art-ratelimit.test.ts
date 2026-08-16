// Which rate-limit bucket the cover-art proxy spends.
//
// Separate file from collection-art.test.ts on purpose: this pins one property that is easy
// to regress by copying another endpoint's boilerplate, and a whole page of a fan's
// collection depends on it.
//
// A collection grid renders 15 tiles, and most have no stored art_url — only ~28% of a real
// import matches an Unstream release — so one page view fires a dozen or more requests here.
// On the 30/min 'standard' bucket that spends the person's entire budget in two page views
// and then 429s their settings page, their release lists, and any artist page they open.
// Reported in production 2026-08-16.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn((): Promise<{ limited: boolean; response?: unknown }> =>
    Promise.resolve({ limited: false })
  ),
  mockGetClientIp: vi.fn(() => '203.0.113.7'),
}));

vi.mock('../db', () => ({ getClient: () => ({ from: mocks.mockFrom }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.mockCreateClient }));
vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));

import { handler } from '../collection-art';

const ITEM_ID = '11111111-1111-4111-8111-111111111111';

describe('collection-art rate limiting', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockCreateClient.mockReturnValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: 'no token' }) },
    });
    // Item lookup returns nothing; the request is refused after the rate-limit check, which
    // is all this file cares about.
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) })),
      })),
    });
  });

  it('spends the lenient bucket, not the standard one shared with account endpoints', async () => {
    await handler({ httpMethod: 'GET', headers: {}, pathParameters: { id: ITEM_ID } });

    expect(mocks.mockCheckRateLimit).toHaveBeenCalledWith(
      '203.0.113.7',
      'lenient',
      expect.anything()
    );
  });

  it('still refuses the request when the bucket is spent', async () => {
    mocks.mockCheckRateLimit.mockResolvedValue({
      limited: true,
      response: { statusCode: 429, headers: {}, body: '{"error":"Rate limit exceeded"}' },
    });

    const res = await handler({ httpMethod: 'GET', headers: {}, pathParameters: { id: ITEM_ID } });

    expect(res.statusCode).toBe(429);
    // Refused before any database work — the point of checking first.
    expect(mocks.mockFrom).not.toHaveBeenCalled();
  });
});
