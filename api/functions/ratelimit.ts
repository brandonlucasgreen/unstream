// Rate limiting utility using Upstash Redis
// Provides per-IP and per-user rate limiting for API endpoints

import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

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

// Standard rate limit: 30 requests per minute (unauthenticated / general)
let standardLimiter: Ratelimit | null = null;

// Strict rate limit: 10 requests per minute (scraping / expensive endpoints)
let strictLimiter: Ratelimit | null = null;

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

  // If Redis isn't configured, allow the request (fail open)
  if (!limiter) return { limited: false };

  try {
    const result = await limiter.limit(identifier);

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

/**
 * Extract client IP from Netlify function event headers.
 */
export function getClientIp(headers: Record<string, string | undefined>): string {
  return headers['x-forwarded-for']?.split(',')[0]?.trim()
    || headers['x-nf-client-connection-ip']
    || headers['client-ip']
    || 'unknown';
}
