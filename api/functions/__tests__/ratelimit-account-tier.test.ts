import { describe, it, expect, vi, beforeEach } from 'vitest';

// A signed-in user's account endpoints used to share the 'standard' bucket with artist page
// views and analytics events. /settings fans out to six of them at once, so browsing a handful
// of artist pages first could spend the budget and 429 the settings page on itself
// (Sentry UNSTREAM-WEB-12). These pin the separation.

const limitCalls: { prefix: string; identifier: string }[] = [];
const built: { prefix: string; window: unknown }[] = [];

vi.mock('../redis', () => ({
  getRedis: () => ({}),
  reportRedisFailure: vi.fn(),
}));

const captureException = vi.fn();
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: (...args: unknown[]) => captureException(...args) },
}));

// Stands in for JWT verification. Whether a given token verifies is middleware's contract,
// not this module's — what's tested here is only what accountRateLimitKey does with the
// answer, which is the part that decides who shares a bucket with whom.
const authenticateBearerFast = vi.fn();
vi.mock('../middleware', () => ({
  authenticateBearerFast: (...args: unknown[]) => authenticateBearerFast(...args),
}));

vi.mock('@upstash/ratelimit', () => {
  class FakeRatelimit {
    prefix: string;
    constructor(opts: { prefix: string; limiter: unknown }) {
      this.prefix = opts.prefix;
      built.push({ prefix: opts.prefix, window: opts.limiter });
    }
    static slidingWindow(tokens: number, window: string) {
      return { tokens, window };
    }
    async limit(identifier: string) {
      limitCalls.push({ prefix: this.prefix, identifier });
      return { success: true, reset: 0 };
    }
  }
  return { Ratelimit: FakeRatelimit };
});

describe('account rate limit tier', () => {
  beforeEach(() => {
    limitCalls.length = 0;
    built.length = 0;
    vi.resetModules();
  });

  it('spends a different bucket than browsing traffic from the same IP', async () => {
    const { checkRateLimit } = await import('../ratelimit');

    await checkRateLimit('1.2.3.4', 'standard', {});
    await checkRateLimit('1.2.3.4', 'account', {});

    const prefixes = limitCalls.map(c => c.prefix).sort();
    expect(prefixes).toEqual([
      'rl:account',
      'rl:daily:account',
      'rl:daily:standard',
      'rl:standard',
    ]);
  });

  it('gives the account tier room for a full settings page load', async () => {
    const { checkRateLimit } = await import('../ratelimit');
    await checkRateLimit('1.2.3.4', 'account', {});

    // /settings fetches six panels per load. 60/min keeps a human comfortably clear of it
    // even with a token refresh partway through.
    const perMinute = built.find(b => b.prefix === 'rl:account');
    expect(perMinute?.window).toEqual({ tokens: 60, window: '1 m' });
  });
});

describe('accountRateLimitKey', () => {
  beforeEach(() => {
    authenticateBearerFast.mockReset();
    vi.resetModules();
  });

  it('gives two users on one IP separate budgets', async () => {
    const { accountRateLimitKey } = await import('../ratelimit');

    authenticateBearerFast.mockResolvedValueOnce({ userId: 'user-a', email: 'a@example.com' });
    const a = await accountRateLimitKey('Bearer a', '203.0.113.1');
    authenticateBearerFast.mockResolvedValueOnce({ userId: 'user-b', email: 'b@example.com' });
    const b = await accountRateLimitKey('Bearer b', '203.0.113.1');

    // The whole point of the change: one office network is no longer one budget.
    expect(a).toBe('user:user-a');
    expect(b).toBe('user:user-b');
    expect(a).not.toBe(b);
  });

  it('falls back to the IP when the token does not verify', async () => {
    const { accountRateLimitKey } = await import('../ratelimit');

    // A forged token has to buy a *different* bucket, never an extra one — otherwise
    // rotating the `sub` claim would be unlimited requests.
    authenticateBearerFast.mockResolvedValue(null);

    expect(await accountRateLimitKey('Bearer forged', '203.0.113.1')).toBe('ip:203.0.113.1');
    expect(await accountRateLimitKey(undefined, '203.0.113.1')).toBe('ip:203.0.113.1');
  });

  it('falls back to the IP rather than failing the request when verification throws', async () => {
    const { accountRateLimitKey } = await import('../ratelimit');
    authenticateBearerFast.mockRejectedValue(new Error('JWKS unreachable'));

    expect(await accountRateLimitKey('Bearer x', '203.0.113.1')).toBe('ip:203.0.113.1');
  });
});

// The account endpoints take their user from here rather than calling the auth server a
// second time for a user id the bucket already required. What has to hold is that the user
// reported alongside the key is the one the key was derived from, and that "no bucket for
// this user" and "no user" stay the same answer — otherwise an endpoint could act on a
// caller whose token never verified.
describe('resolveAccountRequest', () => {
  beforeEach(() => {
    authenticateBearerFast.mockReset();
    captureException.mockReset();
    vi.resetModules();
  });

  it('reports the verified user alongside the key derived from it', async () => {
    const { resolveAccountRequest } = await import('../ratelimit');
    authenticateBearerFast.mockResolvedValue({ userId: 'user-a', email: 'a@example.com' });

    expect(await resolveAccountRequest('Bearer a', '203.0.113.1')).toEqual({
      key: 'user:user-a',
      user: { userId: 'user-a', email: 'a@example.com' },
    });
  });

  it('reports no user whenever it falls back to the IP bucket', async () => {
    const { resolveAccountRequest } = await import('../ratelimit');

    authenticateBearerFast.mockResolvedValue(null);
    expect(await resolveAccountRequest('Bearer forged', '203.0.113.1')).toEqual({
      key: 'ip:203.0.113.1',
      user: null,
    });
    expect(await resolveAccountRequest(undefined, '203.0.113.1')).toEqual({
      key: 'ip:203.0.113.1',
      user: null,
    });

    // A verification that throws is "we don't know who this is", not "trust them".
    authenticateBearerFast.mockRejectedValue(new Error('JWKS unreachable'));
    expect(await resolveAccountRequest('Bearer x', '203.0.113.1')).toEqual({
      key: 'ip:203.0.113.1',
      user: null,
    });
  });

  it('reports a verification it could not perform, rather than swallowing it', async () => {
    const { resolveAccountRequest } = await import('../ratelimit');
    // Reaching this needs local verification to be unavailable *and* the auth-server fallback
    // inside authenticateBearerFast to fail outright — i.e. Supabase Auth is unreachable. The
    // caller will answer 401, telling a signed-in person they aren't signed in, so a wave of
    // these has to be visible as an outage rather than looking like expired sessions.
    authenticateBearerFast.mockRejectedValue(new Error('JWKS unreachable'));

    const resolved = await resolveAccountRequest('Bearer x', '203.0.113.1');

    expect(resolved).toEqual({ key: 'ip:203.0.113.1', user: null });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('verifies the token once per request', async () => {
    const { resolveAccountRequest } = await import('../ratelimit');
    authenticateBearerFast.mockResolvedValue({ userId: 'user-a', email: 'a@example.com' });

    await resolveAccountRequest('Bearer a', '203.0.113.1');

    // The whole point: one check answers both "which bucket" and "which user".
    expect(authenticateBearerFast).toHaveBeenCalledTimes(1);
  });
});
