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
