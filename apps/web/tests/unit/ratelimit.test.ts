import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// checkSentryDedup unit tests
// ---------------------------------------------------------------------------
//
// checkSentryDedup fires on the search path — zero-result searches, per-platform failures,
// dead Bandcamp links — so its cost is paid per search, sometimes several times over. It used
// to be a GET followed by a SET: two billed Upstash commands to answer one question, and a
// race where two containers could both read "not seen" and both capture. `SET ... NX EX` does
// both halves in one command, atomically. These tests pin that, and pin that Redis can never
// silence Sentry.
//
// Strategy: We mock @upstash/redis at the module level. The ratelimit module
// has a module-level `redis` variable that caches the Redis client created by
// getRedis(). To test different scenarios (Redis configured vs not), we
// manipulate environment variables and use vi.resetModules() to force
// re-evaluation.
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockSet = vi.fn();

// The mock factory must return a class (constructable function) since
// getRedis() calls `new Redis(...)`. Using vi.fn().mockImplementation()
// creates a proper mock constructor.
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function(this: any) {
    this.get = mockGet;
    this.set = mockSet;
  }),
}));

// Also mock @upstash/ratelimit so existing code in the module doesn't fail
vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: vi.fn().mockImplementation(() => ({
    limit: vi.fn(),
  })),
}));

describe('checkSentryDedup', () => {
  let checkSentryDedup: (key: string, ttlSeconds: number) => Promise<boolean>;

  beforeEach(async () => {
    // Reset modules to clear cached `redis` variable in ratelimit.ts
    vi.resetModules();
    mockGet.mockReset();
    mockSet.mockReset();

    // Set env vars so getRedis() returns a client
    process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

    // Re-import to get fresh module state
    const mod = await import('../../../../api/functions/ratelimit');
    checkSentryDedup = mod.checkSentryDedup;
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('claims the window in one command, not a GET then a SET', async () => {
    mockSet.mockResolvedValue('OK');

    const result = await checkSentryDedup('uc5:radiohead', 86400);
    expect(result).toBe(true);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith('sentry:dedup:uc5:radiohead', '1', { ex: 86400, nx: true });
  });

  // NX returns null when the key already exists — that is the "already captured" answer, and
  // it costs the same single command the first occurrence did.
  it('returns false on second call (key already seen within TTL)', async () => {
    mockSet.mockResolvedValue(null);

    const result = await checkSentryDedup('uc5:radiohead', 86400);
    expect(result).toBe(false);
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  // Redis must never be able to silence Sentry: an outage that suppressed error reporting is
  // exactly the failure mode api/functions/redis.ts was written to prevent.
  it('returns true (fail-open) when Redis throws an error', async () => {
    mockSet.mockRejectedValue(new Error('Redis connection failed'));

    const result = await checkSentryDedup('uc5:radiohead', 86400);
    expect(result).toBe(true);
  });

  it('uses the provided key and TTL correctly', async () => {
    mockSet.mockResolvedValue('OK');

    await checkSentryDedup('uc6:bandcamp:fetch failed', 3600);
    expect(mockSet).toHaveBeenCalledWith('sentry:dedup:uc6:bandcamp:fetch failed', '1', { ex: 3600, nx: true });
  });

  it('handles empty key strings', async () => {
    mockSet.mockResolvedValue('OK');

    // Edge case: empty normalizedQuery or errorMessage
    const result = await checkSentryDedup('uc5:', 86400);
    expect(result).toBe(true);
  });

  it('returns true (fail-open) when Redis is not configured', async () => {
    // Remove env vars to simulate no Redis config
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    // Re-import to clear cached Redis client
    vi.resetModules();
    const mod = await import('../../../../api/functions/ratelimit');
    const freshDedup = mod.checkSentryDedup;

    const result = await freshDedup('uc5:radiohead', 86400);
    expect(result).toBe(true);
  });
});