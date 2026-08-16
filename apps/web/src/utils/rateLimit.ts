/**
 * A 429 from our own API is backpressure, not a fault. The per-IP budget in
 * `api/functions/ratelimit.ts` is spent and refills on its own, so there is nothing
 * to fix and nothing to wake up to.
 *
 * Reporting these as exceptions buried the real failures: a single rate-limited
 * /settings load raised five separate "Failed to load X" errors in Sentry
 * (UNSTREAM-WEB-12), none of which described what had actually happened — and the
 * user was told to "try again", which is the one thing that makes it worse.
 */
export const RATE_LIMIT_MESSAGE = 'Too many requests right now. Wait a minute, then refresh the page.';
