import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Guards the July 2026 outage: a deleted Upstash database made every Redis command spend the
// SDK's default retry budget (~4.3s) before the caller failed open, with nothing in Sentry.
// Rate-limited endpoints gained a fixed ~4.4s and production search hit 13-30s.
//
// The two properties that keep a repeat cheap and visible are the capped retry config and the
// circuit breaker, so those are what these tests pin down.

const mocks = vi.hoisted(() => ({
  redisCtor: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor(config: unknown) {
      mocks.redisCtor(config);
    }
  },
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException },
}));

import { getRedis, reportRedisFailure, resetRedisStateForTests } from '../redis';

describe('Upstash Redis client resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisStateForTests();
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('caps the retry budget so an unreachable Redis cannot cost seconds', () => {
    getRedis();

    expect(mocks.redisCtor).toHaveBeenCalledTimes(1);
    const config = mocks.redisCtor.mock.calls[0][0] as {
      retry: { retries: number; backoff: (n: number) => number };
    };

    // The SDK default is 5 retries with exponential backoff:
    // 50 + 136 + 370 + 1004 + 2730 = ~4.3s per command. Anything above ~1 retry with a
    // flat backoff puts us back in "silently 4s slower" territory.
    expect(config.retry.retries).toBe(1);
    expect(config.retry.backoff(0)).toBeLessThanOrEqual(100);
    expect(config.retry.backoff(4)).toBeLessThanOrEqual(100);
  });

  it('returns null without constructing a client when Upstash is unconfigured', () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    expect(getRedis()).toBeNull();
    expect(mocks.redisCtor).not.toHaveBeenCalled();
  });

  it('reuses one client across calls', () => {
    const first = getRedis();
    const second = getRedis();

    expect(first).toBe(second);
    expect(mocks.redisCtor).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit after a failure so later calls skip Redis entirely', () => {
    expect(getRedis()).not.toBeNull();

    reportRedisFailure('cacheGet(artist:bandcamp:radiohead)', new Error('fetch failed'));

    // This is what stops a dead Redis from taxing every call site in a request.
    expect(getRedis()).toBeNull();
  });

  it('closes the circuit again after the cooldown', () => {
    vi.useFakeTimers();

    reportRedisFailure('checkRateLimit(standard)', new Error('fetch failed'));
    expect(getRedis()).toBeNull();

    vi.advanceTimersByTime(30_001);

    // Recovery must not need a deploy — Redis coming back should just start working.
    expect(getRedis()).not.toBeNull();
  });

  it('reports the failure to Sentry, tagged for filtering', () => {
    const error = new Error('fetch failed');
    reportRedisFailure('cacheGet(artist:ampwall:boy-harsher)', error);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = mocks.captureException.mock.calls[0];
    expect(captured).toBe(error);
    expect(context.tags).toEqual({ subsystem: 'redis' });
    expect(context.extra.context).toBe('cacheGet(artist:ampwall:boy-harsher)');
  });

  it('wraps a non-Error rejection so Sentry still gets a stack', () => {
    reportRedisFailure('cacheSet(x)', 'string rejection');

    const [captured] = mocks.captureException.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('string rejection');
  });

  it('throttles Sentry reports so an outage cannot flood the project', () => {
    vi.useFakeTimers();

    reportRedisFailure('a', new Error('1'));
    reportRedisFailure('b', new Error('2'));
    reportRedisFailure('c', new Error('3'));

    expect(mocks.captureException).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000 + 1);
    reportRedisFailure('d', new Error('4'));

    expect(mocks.captureException).toHaveBeenCalledTimes(2);
  });
});
