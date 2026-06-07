import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// checkSentryDedup unit tests
// ---------------------------------------------------------------------------
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

  it('returns true on first call (key not seen before)', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');

    const result = await checkSentryDedup('uc5:radiohead', 86400);
    expect(result).toBe(true);
    expect(mockGet).toHaveBeenCalledWith('sentry:dedup:uc5:radiohead');
    expect(mockSet).toHaveBeenCalledWith('sentry:dedup:uc5:radiohead', '1', { ex: 86400 });
  });

  it('returns false on second call (key already seen within TTL)', async () => {
    mockGet.mockResolvedValue('1');

    const result = await checkSentryDedup('uc5:radiohead', 86400);
    expect(result).toBe(false);
    // Should NOT set again when already seen
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('returns true (fail-open) when Redis throws an error', async () => {
    mockGet.mockRejectedValue(new Error('Redis connection failed'));

    const result = await checkSentryDedup('uc5:radiohead', 86400);
    expect(result).toBe(true);
  });

  it('uses the provided key and TTL correctly', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');

    await checkSentryDedup('uc6:bandcamp:fetch failed', 3600);
    expect(mockGet).toHaveBeenCalledWith('sentry:dedup:uc6:bandcamp:fetch failed');
    expect(mockSet).toHaveBeenCalledWith('sentry:dedup:uc6:bandcamp:fetch failed', '1', { ex: 3600 });
  });

  it('handles empty key strings', async () => {
    mockGet.mockResolvedValue(null);
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