// Redis cache utility using Upstash
// Used to cache external API responses (e.g., Ampwall) to reduce load on partners

import { Redis } from '@upstash/redis';

// Initialize Redis client (lazy - only connects when first used)
let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn('[Cache] Upstash Redis not configured - caching disabled');
    return null;
  }

  redis = new Redis({ url, token });
  return redis;
}

// Default TTL: 30 minutes
const DEFAULT_TTL = 30 * 60;

/**
 * Get a value from cache
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const value = await client.get<T>(key);
    if (value) {
      console.log(`[Cache] HIT: ${key}`);
    }
    return value;
  } catch (error) {
    console.error(`[Cache] GET error for ${key}:`, error);
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
    console.log(`[Cache] SET: ${key} (TTL: ${ttlSeconds}s)`);
    return true;
  } catch (error) {
    console.error(`[Cache] SET error for ${key}:`, error);
    return false;
  }
}

/**
 * Helper: Get from cache or fetch from source
 * Handles the common pattern of cache-aside
 */
export async function cacheGetOrFetch<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSeconds: number = DEFAULT_TTL
): Promise<{ data: T; cached: boolean }> {
  // Try cache first
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    return { data: cached, cached: true };
  }

  // Fetch fresh data
  const data = await fetchFn();

  // Cache for next time (don't await - fire and forget)
  cacheSet(key, data, ttlSeconds).catch(() => {});

  return { data, cached: false };
}

/**
 * Generate a normalized cache key for artist searches
 */
export function artistCacheKey(platform: string, query: string): string {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, '_');
  return `artist:${platform}:${normalized}`;
}
