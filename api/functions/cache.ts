// Redis cache utility using Upstash
// Used to cache external API responses (e.g., Ampwall) to reduce load on partners
//
// A Redis outage degrades to "every lookup is a miss", which is safe but means every repeat
// query re-fetches from the partner. That is a politeness problem as much as a latency one,
// so failures are reported rather than swallowed — see api/functions/redis.ts.

import { getRedis, reportRedisFailure } from './redis';

// Default TTL: 30 minutes
const DEFAULT_TTL = 30 * 60;

/**
 * Cache keys are `artist:<platform>:<normalized query>` — the query is the key, that's what a
 * cache is. But it doesn't belong in a log line or a Sentry breadcrumb: knowing *which* platform
 * hit or missed is the whole diagnostic value, and the artist name adds nothing to it. Keep the
 * shape, drop the term.
 */
function redactKey(key: string): string {
  const parts = key.split(':');
  return parts.length > 2 ? `${parts.slice(0, 2).join(':')}:…` : key;
}

/**
 * Values for a set of keys, read up front in a single round trip.
 *
 * A key is present iff Redis held a value for it, so `has()` distinguishes a hit from a
 * miss and an absent key is a miss, not "unknown". Pass one to `cacheGetOrFetch` and it
 * skips its own `GET` entirely.
 */
export type PrefetchedCache = Map<string, unknown>;

/**
 * Read many keys in one `MGET` instead of one `GET` each.
 *
 * Upstash charges per command, and the search fan-out reads one key per platform for the
 * same query — five separate billed commands, five separate HTTP round trips, every search.
 * `MGET` is one of each. Returns an empty map when Redis is unavailable, which every caller
 * already treats as "everything missed".
 */
export async function cachePrefetch(keys: string[]): Promise<PrefetchedCache> {
  const found: PrefetchedCache = new Map();
  if (keys.length === 0) return found;

  const client = getRedis();
  if (!client) return found;

  try {
    const values = await client.mget<unknown[]>(...keys);
    keys.forEach((key, i) => {
      const value = values[i];
      if (value !== null && value !== undefined) found.set(key, value);
    });
    console.log(`[Cache] MGET: ${keys.length} keys, ${found.size} hit`);
  } catch (error) {
    // A failed prefetch is indistinguishable from a cold cache to the caller, which is
    // why — as with cacheGet — it has to be reported rather than swallowed.
    reportRedisFailure(`cachePrefetch(${keys.length} keys)`, error);
  }

  return found;
}

/**
 * Get a value from cache
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const value = await client.get<T>(key);
    if (value) {
      console.log(`[Cache] HIT: ${redactKey(key)}`);
    }
    return value;
  } catch (error) {
    // Indistinguishable from a miss to the caller, which is why it must be reported.
    reportRedisFailure(`cacheGet(${redactKey(key)})`, error);
    return null;
  }
}

/**
 * Set a value in cache with TTL
 */
export async function cacheSet<T>(key: string, value: T, ttlSeconds: number = DEFAULT_TTL): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    await client.set(key, value, { ex: ttlSeconds });
    console.log(`[Cache] SET: ${redactKey(key)} (TTL: ${ttlSeconds}s)`);
    return true;
  } catch (error) {
    reportRedisFailure(`cacheSet(${redactKey(key)})`, error);
    return false;
  }
}

/**
 * Helper: Get from cache or fetch from source
 * Handles the common pattern of cache-aside
 *
 * Pass `shouldCache` when the fetch can return a value meaning "the upstream did not
 * answer" as opposed to "the upstream answered with nothing". Caching the former turns
 * one transient failure into a full TTL of wrong answers for that key.
 *
 * `failureTtlSeconds` then decides what happens to those uncacheable values. Omit it and
 * they are not cached at all — correct, but it means a genuinely down upstream is retried
 * on every request, and callers that wait on a fixed timeout pay that timeout every time.
 * Give it a short value (~60s) for the useful middle ground: a hiccup heals in a minute
 * instead of persisting for the full TTL, while an outage still costs one slow request per
 * minute rather than one per search.
 *
 * `prefetched` lets a fan-out pay for one `MGET` instead of one `GET` per key — see
 * `cachePrefetch`. When it is supplied it is authoritative for this key: the caller has
 * already asked Redis, so an absent key is a miss and no second read is made.
 *
 * It accepts the *promise* as well as the map so the caller doesn't have to await the MGET
 * before starting its fan-out — the platforms with no cache would otherwise all start one
 * round trip later than they used to, which is a latency regression in exchange for a cost
 * saving they don't share in.
 */
export async function cacheGetOrFetch<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSeconds: number = DEFAULT_TTL,
  shouldCache?: (data: T) => boolean,
  failureTtlSeconds?: number,
  prefetched?: PrefetchedCache | Promise<PrefetchedCache>
): Promise<{ data: T; cached: boolean }> {
  // Try cache first
  const cached = prefetched
    ? ((await prefetched).get(key) as T | undefined) ?? null
    : await cacheGet<T>(key);
  if (cached !== null) {
    return { data: cached, cached: true };
  }

  // Fetch fresh data
  const data = await fetchFn();

  // Cache for next time (don't await - fire and forget)
  if (!shouldCache || shouldCache(data)) {
    cacheSet(key, data, ttlSeconds).catch(() => {});
  } else if (failureTtlSeconds && failureTtlSeconds > 0) {
    cacheSet(key, data, failureTtlSeconds).catch(() => {});
  }

  return { data, cached: false };
}

/**
 * Delete a value from cache
 */
export async function cacheDelete(key: string): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;

  try {
    await client.del(key);
    console.log(`[Cache] DEL: ${redactKey(key)}`);
    return true;
  } catch (error) {
    reportRedisFailure(`cacheDelete(${redactKey(key)})`, error);
    return false;
  }
}

/**
 * Delete all cache keys matching a pattern (artist name across all platforms)
 */
export async function cacheDeleteByArtist(artistName: string): Promise<void> {
  const client = getRedis();
  if (!client) return;

  const normalized = artistName.toLowerCase().trim().replace(/\s+/g, '_');
  try {
    // Scan for matching keys and delete them
    const keys: string[] = [];
    let cursor = 0;
    do {
      const [nextCursor, matchedKeys] = await client.scan(cursor, { match: `artist:*:${normalized}`, count: 100 });
      cursor = Number(nextCursor);
      keys.push(...matchedKeys);
    } while (cursor !== 0);

    if (keys.length > 0) {
      await Promise.all(keys.map(k => client.del(k)));
      console.log(`[Cache] Purged ${keys.length} cached entries for one artist`);
    }
  } catch (error) {
    reportRedisFailure('cacheDeleteByArtist', error);
  }
}

/**
 * Generate a normalized cache key for artist searches
 */
export function artistCacheKey(platform: string, query: string): string {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, '_');
  return `artist:${platform}:${normalized}`;
}
