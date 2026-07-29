// Shared Upstash Redis client for cache.ts and ratelimit.ts.
//
// Both callers deliberately fail open: a Redis outage must never break a request. The trap
// is that failing open *slowly and silently* is worse than failing loudly. In July 2026 the
// Upstash database was deleted for inactivity and every Redis command spent the SDK's full
// default retry budget — 5 retries with exponential backoff, 50+136+370+1004+2730 = ~4.3s —
// before the caller caught the error and carried on. Rate-limited endpoints gained a fixed
// ~4.4s, every cache lookup both cost 4.3s and reported a miss, and production search went
// to 13-30s. Nothing reached Sentry, because every catch block only did console.error.
//
// Two guards so a repeat is cheap and visible:
//
//   1. `retry` is capped at one quick attempt. Enough to ride out a transient blip, cheap
//      enough to swallow when Redis is genuinely gone.
//   2. The first failure opens a short circuit, so a dead Redis costs one failed command per
//      container per CIRCUIT_OPEN_MS instead of one per call site.
//
// Failures are reported to Sentry, throttled in memory. Note this cannot use
// checkSentryDedup — that helper needs Redis, which is exactly what is broken.

import { Redis } from '@upstash/redis';
import { Sentry } from '../lib/sentry';

let redis: Redis | null = null;
let warnedMissingConfig = false;

// Module-level state lives for the lifetime of one warm Lambda container: long enough to
// stop a dead Redis from taxing every command, short enough to recover without a deploy.
const CIRCUIT_OPEN_MS = 30_000;
const REPORT_INTERVAL_MS = 5 * 60_000;
let circuitOpenUntil = 0;
let lastReportedAt = 0;

/**
 * Returns the shared Redis client, or null if Redis is unconfigured or currently
 * circuit-broken. Callers must treat null as "skip Redis and carry on".
 *
 * Call this immediately before use rather than caching the result — a memoized client
 * cannot tell you that the circuit has since opened.
 */
export function getRedis(): Redis | null {
  if (Date.now() < circuitOpenUntil) return null;
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // Expected in local dev, where .env has no Upstash vars at all.
    if (!warnedMissingConfig) {
      console.warn('[Redis] Upstash not configured — caching and rate limiting are disabled');
      warnedMissingConfig = true;
    }
    return null;
  }

  redis = new Redis({
    url,
    token,
    retry: { retries: 1, backoff: () => 50 },
  });
  return redis;
}

// The Upstash SDK builds its error messages as
// `${body.error}, command was: ${JSON.stringify(req.body)}` — so the message carries the full
// Redis command, including its keys. Rate-limit keys are `${prefix}:${identifier}` and every
// caller passes the client IP as the identifier, so that message can contain an IP address.
// Console logs stay inside Netlify, but Sentry is a third party, so the command tail is dropped
// before the error leaves the process. The reason for cutting the whole tail rather than
// picking the keys out of it: the shape of req.body is the SDK's business, not ours.
function redactCommand(error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const [head, ...rest] = err.message.split(', command was:');
  if (rest.length === 0) return err;

  const redacted = new Error(`${head}, command was: [redacted]`);
  redacted.name = err.name;
  redacted.stack = err.stack;
  return redacted;
}

/**
 * Record a Redis failure: open the circuit briefly, and report to Sentry.
 *
 * Call from the catch block of every Redis operation. Callers should still fail open —
 * this only makes the failure fast and visible, it does not change the outcome.
 *
 * `context` is sent to Sentry as-is, so it must not contain an identifier. Pass the operation
 * and at most a cache key (those are normalized search terms) — never an IP, user id, or email.
 */
export function reportRedisFailure(context: string, error: unknown): void {
  const now = Date.now();
  circuitOpenUntil = now + CIRCUIT_OPEN_MS;

  console.error(`[Redis] ${context} failed; skipping Redis for ${CIRCUIT_OPEN_MS / 1000}s:`, error);

  if (now - lastReportedAt < REPORT_INTERVAL_MS) return;
  lastReportedAt = now;

  Sentry.captureException(redactCommand(error), {
    tags: { subsystem: 'redis' },
    extra: { context },
  });
}

/** Test seam: reset circuit-breaker and client state between tests. */
export function resetRedisStateForTests(): void {
  redis = null;
  circuitOpenUntil = 0;
  lastReportedAt = 0;
  warnedMissingConfig = false;
}
