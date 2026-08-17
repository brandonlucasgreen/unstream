// Rate limiting utility using Upstash Redis
// Provides per-IP and per-API-key rate limiting for API endpoints
// Supports tiered limits: anonymous (strict), free, pro, internal

import { Ratelimit } from '@upstash/ratelimit';
import { Sentry } from '../lib/sentry';
import { authenticateBearerFast, type ApiKeyInfo, type BearerUser } from './middleware';
import { getRedis, reportRedisFailure } from './redis';

// ---------------------------------------------------------------------------
// Rate limit tiers
// ---------------------------------------------------------------------------

// Anonymous / web app tiers
let standardLimiter: Ratelimit | null = null;   // 30 req/min for general endpoints
let strictLimiter: Ratelimit | null = null;      // 10 req/min for expensive endpoints
let lenientLimiter: Ratelimit | null = null;     // 120 req/min for cheap high-frequency endpoints (typeahead)
let accountLimiter: Ratelimit | null = null;     // 60 req/min for a signed-in user's own account endpoints

// Per-day quota limiters (new)
let standardDailyLimiter: Ratelimit | null = null;  // 1000 req/day for general
let strictDailyLimiter: Ratelimit | null = null;    // 500 req/day for expensive
let lenientDailyLimiter: Ratelimit | null = null;   // 5000 req/day for cheap high-frequency
let accountDailyLimiter: Ratelimit | null = null;   // 2000 req/day for account endpoints

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

// High-frequency, low-cost endpoints (typeahead suggestions): fires on every
// debounced typing pause, so it needs its own bucket — sharing 'standard'
// would let an actively-searching user 429 themselves out of account actions.
function getLenientLimiter(): Ratelimit | null {
  if (lenientLimiter) return lenientLimiter;
  const r = getRedis();
  if (!r) return null;
  lenientLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(120, '1 m'),
    prefix: 'rl:lenient',
  });
  return lenientLimiter;
}

// A signed-in user's own account endpoints (/api/me/*, sharing, saved artists). These are
// cheap authenticated reads, but /settings alone fans out to six of them on a single load —
// sharing 'standard' meant browsing a few artist pages first could spend the budget and 429
// the settings page on itself (Sentry UNSTREAM-WEB-12). Same reasoning as 'lenient' above:
// unrelated traffic shouldn't be able to lock a user out of their own account.
function getAccountLimiter(): Ratelimit | null {
  if (accountLimiter) return accountLimiter;
  const r = getRedis();
  if (!r) return null;
  accountLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(60, '1 m'),
    prefix: 'rl:account',
  });
  return accountLimiter;
}

function getAccountDailyLimiter(): Ratelimit | null {
  if (accountDailyLimiter) return accountDailyLimiter;
  const r = getRedis();
  if (!r) return null;
  accountDailyLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(2000, '24 h'),
    prefix: 'rl:daily:account',
  });
  return accountDailyLimiter;
}

function getLenientDailyLimiter(): Ratelimit | null {
  if (lenientDailyLimiter) return lenientDailyLimiter;
  const r = getRedis();
  if (!r) return null;
  lenientDailyLimiter = new Ratelimit({
    redis: r,
    limiter: Ratelimit.slidingWindow(5000, '24 h'),
    prefix: 'rl:daily:lenient',
  });
  return lenientDailyLimiter;
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

/**
 * The identifier to rate-limit an account endpoint by: the signed-in user when the
 * request carries a valid token, their IP otherwise.
 *
 * Why not IP alone, which is what these endpoints used to do: everyone behind one NAT
 * — an office, a café, a household — shares a single budget, so one person loading
 * /settings can 429 a colleague. A user's own account requests should be bounded by
 * *their* usage and nothing else.
 *
 * Why this can't be gamed: the token is verified, not just decoded. A forged or
 * garbage token fails and falls back to the IP key, so it buys a different bucket,
 * never an extra one. Verification is local (JWKS/HS256, cached in module scope) and
 * costs no network call on a warm invocation, which is what keeps this cheap enough
 * to run *before* the limit — the point of limiting first is that unauthenticated
 * floods must not reach the auth server.
 *
 * Prefer `resolveAccountRequest` below, which hands back the verified user alongside the
 * key so the caller doesn't re-verify. This narrower version remains for callers that
 * genuinely only want a bucket name.
 */
export async function accountRateLimitKey(
  authHeader: string | undefined,
  ip: string
): Promise<string> {
  return (await resolveAccountRequest(authHeader, ip)).key;
}

/** A rate-limit bucket plus whoever the request's token says it belongs to. */
export interface AccountRequest {
  /** `user:<id>` when the token verified, `ip:<addr>` when it didn't. */
  key: string;
  /** The verified user, or null when the request carries no usable token. */
  user: BearerUser | null;
}

/**
 * Derive the rate-limit bucket *and* keep the user that deriving it already produced.
 *
 * The bucket can only be keyed by user if the token has been verified, so by the time a
 * key exists the work of authenticating is done. Discarding the result meant nine account
 * endpoints then called `anonClient.auth.getUser(token)` to learn the same user id — a
 * round trip to the auth server on every request, on top of a local check that had
 * already answered.
 *
 * #458 noted the double verification and judged it fine, correctly, for the two endpoints
 * on the fast path: two local signature checks against a memoized key set cost nothing.
 * That reasoning didn't extend to the rest, where the second check leaves the building.
 *
 * The trade this makes explicit is PR #331's, now applied to these endpoints too: a
 * session revoked server-side keeps working until its access token expires (~1 hour).
 * That is fine for reads and for a user's own settings. Where a fresh server-side check
 * matters more than latency — `me-password`, which changes a credential, and the admin
 * paths — keep using `authenticateBearer`.
 */
export async function resolveAccountRequest(
  authHeader: string | undefined,
  ip: string
): Promise<AccountRequest> {
  try {
    const user = await authenticateBearerFast(authHeader);
    if (user) return { key: `user:${user.userId}`, user };
  } catch (error) {
    // Verification is best-effort for the *bucket* — not knowing who this is, is exactly
    // what the IP fallback is for, and this must never fail the request.
    //
    // But it decides the *user* too now, and "we couldn't check the token" is not the same
    // answer as "the token is bad". A throw here needs both local verification to be
    // unavailable and the auth-server fallback inside authenticateBearerFast to fail
    // outright, so it means Supabase Auth is unreachable — and the caller will answer 401,
    // telling a signed-in person they aren't. Before this helper owned the auth decision
    // that same outage surfaced as an unhandled 500, which at least reached Sentry. So it
    // is reported rather than swallowed: a wave of these is an outage, not expired sessions.
    Sentry.captureException(error, {
      level: 'warning',
      tags: { context: 'ratelimit.resolveAccountRequest' },
      extra: { note: 'token verification unavailable — request will be treated as signed out' },
    });
  }
  return { key: `ip:${ip}`, user: null };
}

export type RateLimitTier = 'standard' | 'strict' | 'lenient' | 'account';

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
  const limiter = tier === 'strict' ? getStrictLimiter()
    : tier === 'lenient' ? getLenientLimiter()
    : tier === 'account' ? getAccountLimiter()
    : getStandardLimiter();
  const dailyLimiter = tier === 'strict' ? getStrictDailyLimiter()
    : tier === 'lenient' ? getLenientDailyLimiter()
    : tier === 'account' ? getAccountDailyLimiter()
    : getStandardDailyLimiter();

  // If Redis isn't configured, allow the request (fail open). The getRedis() call is not
  // redundant: the limiter getters above memoize, so a cached limiter cannot tell us that
  // the circuit breaker has since opened.
  if (!limiter || !getRedis()) return { limited: false };

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
    reportRedisFailure(`checkRateLimit(${tier})`, error);
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

  // As in checkRateLimit, re-check getRedis() so a memoized limiter can't outlive the circuit.
  if (!perMin || !getRedis()) return { limited: false, rateLimitInfo: { limit: perMinLimit, remaining: perMinLimit, reset: Math.ceil(Date.now() / 1000) + 60 } };

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
    reportRedisFailure(`checkApiRateLimit(${apiKeyInfo.tier})`, error);
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
    reportRedisFailure('checkSentryDedup', err);
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