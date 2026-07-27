// Rate limiting utility using Upstash Redis
// Provides per-IP and per-API-key rate limiting for API endpoints
// Supports tiered limits: anonymous (strict), free, pro, internal

import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import type { ApiKeyInfo } from './middleware';

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn('[RateLimit] Upstash Redis not configured - rate limiting disabled');
    return null;
  }

  redis = new Redis({ url, token });
  return redis;
}

// ---------------------------------------------------------------------------
// Rate limit tiers
// ---------------------------------------------------------------------------

// Anonymous / web app tiers
let standardLimiter: Ratelimit | null = null;   // 30 req/min for general endpoints
let strictLimiter: Ratelimit | null = null;      // 10 req/min for expensive endpoints

// Per-day quota limiters (new)
let standardDailyLimiter: Ratelimit | null = null;  // 1000 req/day for general
let strictDailyLimiter: Ratelimit | null = null;    // 500 req/day for expensive

// API key tiers
let freeLimiter: Ratelimit | null = null;        // 30 req/min
let proLimiter: Ratelimit | null = null;         // 100 req/min
let internalLimiter: Ratelimit | null = null;    // 300 req/min

let freeDailyLimiter: Ratelimit | null = null;   // 100 req/day
let proDailyLimiter: Ratelimit | null = null;    // 10000 req/day
// internal daily is unlimited

function getStandardLimiter(): Ratelimit | null {
  if (standardLimiter) return standardLimiter;
  const r = getRedis();
  if (!r) return null;
  standardLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(30, '1 m'),
    prefix: 'rl:standard',
  });
  return standardLimiter;
}

function getStrictLimiter(): Ratelimit | null {
  if (strictLimiter) return strictLimiter;
  const r = getRedis();
  if (!r) return null;
  strictLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(10, '1 m'),
    prefix: 'rl:strict',
  });
  return strictLimiter;
}

function getStandardDailyLimiter(): Ratelimit | null {
  if (standardDailyLimiter) return standardDailyLimiter;
  const r = getRedis();
  if (!r) return null;
  standardDailyLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(1000, '24 h'),
    prefix: 'rl:daily:standard',
  });
  return standardDailyLimiter;
}

function getStrictDailyLimiter(): Ratelimit | null {
  if (strictDailyLimiter) return strictDailyLimiter;
  const r = getRedis();
  if (!r) return null;
  strictDailyLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(500, '24 h'),
    prefix: 'rl:daily:strict',
  });
  return strictDailyLimiter;
}

function getFreeLimiter(): Ratelimit | null {
  if (freeLimiter) return freeLimiter;
  const r = getRedis();
  if (!r) return null;
  freeLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(30, '1 m'),
    prefix: 'rl:api:free',
  });
  return freeLimiter;
}

function getProLimiter(): Ratelimit | null {
  if (proLimiter) return proLimiter;
  const r = getRedis();
  if (!r) return null;
  proLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(100, '1 m'),
    prefix: 'rl:api:pro',
  });
  return proLimiter;
}

function getInternalLimiter(): Ratelimit | null {
  if (internalLimiter) return internalLimiter;
  const r = getRedis();
  if (!r) return null;
  internalLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(300, '1 m'),
    prefix: 'rl:api:internal',
  });
  return internalLimiter;
}

function getFreeDailyLimiter(): Ratelimit | null {
  if (freeDailyLimiter) return freeDailyLimiter;
  const r = getRedis();
  if (!r) return null;
  freeDailyLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(100, '24 h'),
    prefix: 'rl:daily:api:free',
  });
  return freeDailyLimiter;
}

function getProDailyLimiter(): Ratelimit | null {
  if (proDailyLimiter) return proDailyLimiter;
  const r = getRedis();
  if (!r) return null;
  proDailyLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(10000, '24 h'),
    prefix: 'rl:daily:api:pro',
  });
  return proDailyLimiter;
}

// ---------------------------------------------------------------------------
// Original rate limit check (for web app / anonymous requests)
// ---------------------------------------------------------------------------

export type RateLimitTier = 'standard' | 'strict';

interface RateLimitResult {
  limited: boolean;
  response?: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
}

/**
 * Check rate limit for a request. Returns { limited: false } if allowed,
 * or { limited: true, response } with a 429 response if blocked.
 *
 * Identifier should be IP address for unauthenticated endpoints,
 * or user ID for authenticated endpoints.
 */
export async function checkRateLimit(
  identifier: string,
  tier: RateLimitTier,
  corsHeaders: Record<string, string>
): Promise<RateLimitResult> {
  const limiter = tier === 'strict' ? getStrictLimiter() : getStandardLimiter();
  const dailyLimiter = tier === 'strict' ? getStrictDailyLimiter() : getStandardDailyLimiter();

  // If Redis isn't configured, allow the request (fail open)
  if (!limiter) return { limited: false };

  try {
    // Run the daily and per-minute checks in parallel — each is a Redis round-trip,
    // and this check sits in front of every API request. The cost is that a request
    // already over its daily quota also consumes a per-minute token, which is
    // harmless: the request is rejected either way.
    const [dailyResult, result] = await Promise.all([
      dailyLimiter ? dailyLimiter.limit(identifier) : Promise.resolve(null),
      limiter.limit(identifier),
    ]);

    if (dailyResult && !dailyResult.success) {
      console.log(`[RateLimit] Blocked ${tier} daily quota for ${identifier}`);
      return {
        limited: true,
        response: {
          statusCode: 429,
          headers: {
            ...corsHeaders,
            'Retry-After': String(Math.ceil(dailyResult.reset / 1000 - Date.now() / 1000)),
          },
          body: JSON.stringify({ error: 'Daily request limit exceeded. Please try again tomorrow.' }),
        },
      };
    }

    if (!result.success) {
      console.log(`[RateLimit] Blocked ${tier} request from ${identifier}`);
      return {
        limited: true,
        response: {
          statusCode: 429,
          headers: {
            ...corsHeaders,
            'Retry-After': String(Math.ceil(result.reset / 1000 - Date.now() / 1000)),
          },
          body: JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        },
      };
    }

    return { limited: false };
  } catch (error) {
    // Fail open — don't block requests if Redis is down
    console.error('[RateLimit] Check failed, allowing request:', error);
    return { limited: false };
  }
}

// ---------------------------------------------------------------------------
// API key rate limit check (for v1 endpoints)
// ---------------------------------------------------------------------------

export interface ApiRateLimitResult {
  limited: boolean;
  response?: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
  /** Rate limit info to include in response headers */
  rateLimitInfo?: {
    limit: number;
    remaining: number;
    reset: number;
  };
}

/**
 * Check rate limit for an API key request.
 * Uses tiered limits based on the API key's tier.
 * Falls back to strict anonymous limits if no API key.
 */
export async function checkApiRateLimit(
  apiKeyInfo: ApiKeyInfo | null,
  identifier: string,
  corsHeaders: Record<string, string>,
): Promise<ApiRateLimitResult> {
  // If no API key, use strict anonymous limits
  if (!apiKeyInfo) {
    const result = await checkRateLimit(identifier, 'strict', corsHeaders);
    return {
      limited: result.limited,
      response: result.response,
      // Anonymous requests don't expose per-request remaining counts
      rateLimitInfo: undefined,
    };
  }

  // Select limiters based on key tier
  const tierLimiters: Record<string, { perMin: Ratelimit | null; daily: Ratelimit | null; perMinLimit: number; dailyLimit: number }> = {
    free: { perMin: getFreeLimiter(), daily: getFreeDailyLimiter(), perMinLimit: 30, dailyLimit: 100 },
    pro: { perMin: getProLimiter(), daily: getProDailyLimiter(), perMinLimit: 100, dailyLimit: 10000 },
    internal: { perMin: getInternalLimiter(), daily: null, perMinLimit: 300, dailyLimit: 0 },
  };

  const { perMin, daily, perMinLimit, dailyLimit } = tierLimiters[apiKeyInfo.tier] || tierLimiters.free;

  // Use key UUID as identifier for per-key rate limiting (prefix is too short for uniqueness)
  const keyId = `rl:api:${apiKeyInfo.id}`;

  if (!perMin) return { limited: false, rateLimitInfo: { limit: perMinLimit, remaining: perMinLimit, reset: Math.ceil(Date.now() / 1000) + 60 } };

  try {
    // Daily and per-minute checks run in parallel (each is a Redis round-trip).
    // Internal tier has no daily limiter. Same tradeoff as checkRateLimit: a
    // daily-blocked request also consumes a per-minute token, harmlessly.
    const [dailyResult, perMinResult] = await Promise.all([
      daily && dailyLimit > 0 ? daily.limit(keyId) : Promise.resolve(null),
      perMin.limit(keyId),
    ]);

    if (dailyResult && !dailyResult.success) {
      console.log(`[RateLimit] Blocked ${apiKeyInfo.tier} daily quota for key ${apiKeyInfo.keyPrefix}`);
      return {
        limited: true,
        response: {
          statusCode: 429,
          headers: {
            ...corsHeaders,
            'Retry-After': String(Math.ceil(dailyResult.reset / 1000 - Date.now() / 1000)),
            'X-RateLimit-Limit': String(dailyLimit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(dailyResult.reset / 1000)),
          },
          body: JSON.stringify({ error: 'Daily request limit exceeded. Please try again tomorrow.' }),
        },
      };
    }

    if (!perMinResult.success) {
      console.log(`[RateLimit] Blocked ${apiKeyInfo.tier} API request from key ${apiKeyInfo.keyPrefix}`);
      return {
        limited: true,
        response: {
          statusCode: 429,
          headers: {
            ...corsHeaders,
            'Retry-After': String(Math.ceil(perMinResult.reset / 1000 - Date.now() / 1000)),
            'X-RateLimit-Limit': String(perMinLimit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.ceil(perMinResult.reset / 1000)),
          },
          body: JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
        },
      };
    }

    // Return daily info if available, otherwise per-minute info
    if (daily && dailyLimit > 0) {
      // Re-check to get remaining count (the limit() call above already decremented)
      return {
        limited: false,
        rateLimitInfo: {
          limit: perMinLimit,
          remaining: perMinResult.remaining,
          reset: Math.ceil(perMinResult.reset / 1000),
        },
      };
    }

    return {
      limited: false,
      rateLimitInfo: {
        limit: perMinLimit,
        remaining: perMinResult.remaining,
        reset: Math.ceil(perMinResult.reset / 1000),
      },
    };
  } catch (error) {
    // Fail open — don't block requests if Redis is down
    console.error('[RateLimit] API rate limit check failed, allowing request:', error);
    return { limited: false, rateLimitInfo: { limit: perMinLimit, remaining: perMinLimit, reset: Math.ceil(Date.now() / 1000) + 60 } };
  }
}

/**
 * Deduplicates Sentry captureMessage calls by key. Once a key has been
 * captured, subsequent calls with the same key within `ttlSeconds` return
 * false (skip the capture). This prevents high-volume Sentry noise from
 * zero-result searches, repeated platform failures, etc.
 *
 * Returns true if the capture should proceed (this is the first occurrence
 * in the TTL window), false if it should be skipped (already captured
 * within the window).
 *
 * If Redis is not configured, returns true (capture always proceeds) so
 * Sentry still works in local dev.
 */
export async function checkSentryDedup(key: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true; // Redis unavailable → don't gate Sentry on it
  try {
    const cacheKey = `sentry:dedup:${key}`;
    const seen = await r.get(cacheKey);
    if (seen) return false;
    await r.set(cacheKey, '1', { ex: ttlSeconds });
    return true;
  } catch (err) {
    // On Redis error, don't block Sentry capture — fail open
    console.warn('[RateLimit] checkSentryDedup error, allowing capture:', err);
    return true;
  }
}

/**
 * Extract client IP from Netlify function event headers.
 */
export function getClientIp(headers: Record<string, string | undefined>): string {
  // Prefer Netlify's trusted header (cannot be spoofed by clients)
  return headers['x-nf-client-connection-ip']
    || headers['client-ip']
    || headers['x-forwarded-for']?.split(',')[0]?.trim()
    || 'unknown';
}