// The flag store is the one Redis reader that must fail closed (see the header of
// feature-flags.ts): a flag that reads "on" by accident ships a half-built feature to everyone,
// so every failure path — no client, throwing hgetall, missing hash, missing field — has to
// come back false, and a failed write has to be distinguishable from a successful one.
//
// Redis is stubbed rather than reached: cache-should-cache.test.ts explains why the Netlify
// build, which carries production Upstash credentials, makes a real client unsafe here.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  client: null as Record<string, unknown> | null,
  hgetall: vi.fn(),
  hset: vi.fn(),
  getRedis: vi.fn(),
  reportRedisFailure: vi.fn(),
}));

vi.mock('../redis', () => ({
  getRedis: mocks.getRedis,
  reportRedisFailure: mocks.reportRedisFailure,
}));

const {
  FEATURE_FLAGS,
  FLAGS_HASH_KEY,
  FeatureFlagStoreUnavailableError,
  getFeatureFlag,
  getFeatureFlags,
  isFeatureFlag,
  setFeatureFlag,
} = await import('../feature-flags');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.stored.clear();
  mocks.client = {
    hgetall: (key: string) => mocks.hgetall(key),
    hset: (key: string, value: Record<string, unknown>) => mocks.hset(key, value),
  };
  mocks.getRedis.mockImplementation(() => mocks.client);
  mocks.hgetall.mockImplementation(async (key: string) =>
    key === FLAGS_HASH_KEY ? Object.fromEntries(mocks.stored) : null);
  mocks.hset.mockImplementation(async (_key: string, value: Record<string, unknown>) => {
    for (const [field, v] of Object.entries(value)) mocks.stored.set(field, v);
    return 1;
  });
});

describe('the registry', () => {
  it('knows exactly the two flags UNS-215 ships', () => {
    expect([...FEATURE_FLAGS]).toEqual(['tips', 'emailChange']);
  });

  it('recognises known names and rejects everything else', () => {
    expect(isFeatureFlag('tips')).toBe(true);
    expect(isFeatureFlag('emailChange')).toBe(true);
    expect(isFeatureFlag('tipsV2')).toBe(false);
    expect(isFeatureFlag('')).toBe(false);
  });
});

describe('getFeatureFlags', () => {
  it('returns every known flag, all off, when the hash is empty', async () => {
    expect(await getFeatureFlags()).toEqual({ tips: false, emailChange: false });
  });

  it('turns on only the field holding exactly "on"', async () => {
    mocks.stored.set('tips', 'on');
    mocks.stored.set('emailChange', 'off');
    expect(await getFeatureFlags()).toEqual({ tips: true, emailChange: false });
  });

  it('ignores a field whose name is not a known flag', async () => {
    mocks.stored.set('tips', 'on');
    mocks.stored.set('removedFeature', 'on');
    expect(await getFeatureFlags()).toEqual({ tips: true, emailChange: false });
  });

  it.each([['ON'], ['true'], ['1'], [true], [null]])(
    'treats a stored value of %j as off',
    async (value) => {
      mocks.stored.set('tips', value);
      expect(await getFeatureFlags()).toEqual({ tips: false, emailChange: false });
    },
  );

  it('is all off, with no throw, when Redis is unconfigured', async () => {
    mocks.getRedis.mockReturnValue(null);
    expect(await getFeatureFlags()).toEqual({ tips: false, emailChange: false });
    expect(mocks.hgetall).not.toHaveBeenCalled();
    expect(mocks.reportRedisFailure).not.toHaveBeenCalled();
  });

  it('is all off, with no throw, when reading Redis fails, and reports it', async () => {
    const boom = new Error('WRONGTYPE, command was: ["HGETALL","feature-flags"]');
    mocks.hgetall.mockRejectedValue(boom);

    expect(await getFeatureFlags()).toEqual({ tips: false, emailChange: false });
    expect(mocks.reportRedisFailure).toHaveBeenCalledWith(`${FLAGS_HASH_KEY}.getFeatureFlags`, boom);
  });

  it('is all off when the hash itself is missing rather than empty', async () => {
    mocks.hgetall.mockResolvedValue(null);
    expect(await getFeatureFlags()).toEqual({ tips: false, emailChange: false });
  });
});

describe('getFeatureFlag', () => {
  it('reads one flag off the same hash', async () => {
    mocks.stored.set('emailChange', 'on');
    expect(await getFeatureFlag('emailChange')).toBe(true);
    expect(await getFeatureFlag('tips')).toBe(false);
    expect(mocks.hgetall).toHaveBeenCalledWith(FLAGS_HASH_KEY);
  });

  it('is false when Redis fails', async () => {
    mocks.hgetall.mockRejectedValue(new Error('down'));
    expect(await getFeatureFlag('tips')).toBe(false);
  });
});

describe('setFeatureFlag', () => {
  it('writes exactly the one field and value asked for', async () => {
    await setFeatureFlag('tips', true);
    expect(mocks.hset).toHaveBeenCalledWith(FLAGS_HASH_KEY, { tips: 'on' });
    expect(mocks.stored.get('tips')).toBe('on');
    expect(mocks.stored.has('emailChange')).toBe(false);
  });

  it('writes "off" rather than deleting the field', async () => {
    await setFeatureFlag('emailChange', false);
    expect(mocks.hset).toHaveBeenCalledWith(FLAGS_HASH_KEY, { emailChange: 'off' });
    expect(mocks.stored.get('emailChange')).toBe('off');
  });

  it('reads back what it wrote', async () => {
    await setFeatureFlag('tips', true);
    expect(await getFeatureFlags()).toEqual({ tips: true, emailChange: false });
  });

  it('throws, writing nothing, when Redis is unconfigured', async () => {
    mocks.getRedis.mockReturnValue(null);
    await expect(setFeatureFlag('tips', true)).rejects.toBeInstanceOf(FeatureFlagStoreUnavailableError);
    expect(mocks.hset).not.toHaveBeenCalled();
  });

  it('throws and reports when the write fails', async () => {
    const boom = new Error('ECONNRESET');
    mocks.hset.mockRejectedValue(boom);

    await expect(setFeatureFlag('tips', true)).rejects.toBeInstanceOf(FeatureFlagStoreUnavailableError);
    expect(mocks.reportRedisFailure).toHaveBeenCalledWith(`${FLAGS_HASH_KEY}.setFeatureFlag`, boom);
    expect(mocks.stored.has('tips')).toBe(false);
  });
});
