/**
 * Server-side Sentry for the Worker.
 *
 * Reads SENTRY_DSN from the environment. If set, the Worker's entry point starts a Sentry client
 * for each request and the functions' `Sentry.captureException` / `Sentry.captureMessage` calls
 * reach it. If unset, every capture is a no-op — functions work the same without it.
 *
 * Functions must export their handler through `withSentry` (below); `with-sentry.test.ts` fails
 * on one that forgets.
 *
 * **@sentry/cloudflare, not @sentry/node.** The Node SDK carries OpenTelemetry and a stack of
 * Node internals that a Worker has no use for and would have to bundle 66 times over. The
 * Cloudflare SDK is the same `captureException` / `captureMessage` / `flush` API against the
 * same DSN and the same project; server-side events still arrive distinguishable from the web
 * client's. It has no `init()` of its own — the client is created per request by the
 * `Sentry.withSentry` wrapper around the Worker's default export (workers/index.ts), which is
 * also what ties flushing to `waitUntil`.
 *
 * Set in the Worker's environment:
 *   SENTRY_DSN = https://…@o4510896048242688.ingest.us.sentry.io/4511275115151360
 *   SENTRY_ENV = production  (optional; see resolveSentryEnvironment)
 */

import * as SentryCloudflare from '@sentry/cloudflare';

const PRODUCTION_SITE_URL = 'https://unstream.stream';

/**
 * Which environment to tag events with.
 *
 * `SENTRY_ENV` wins when it's set, but it isn't set on this site, and the old fallback chain
 * (`NODE_ENV` → `'development'`) meant every production function error arrived tagged
 * `environment: development`. That isn't cosmetic: it reads as "someone's laptop" and buys a
 * real outage another day of being ignored. The 29-hour release-alert outage of 2026-08-10 was
 * reported exactly that way.
 *
 * `URL` is the signal, and it is set deliberately in wrangler.jsonc's `vars` for that reason.
 * Under `wrangler dev` it is the localhost origin, so local runs still tag as development.
 */
export function resolveSentryEnvironment(): string {
  const explicit = process.env.SENTRY_ENV;
  if (explicit) return explicit;

  const siteUrl = process.env.URL?.replace(/\/$/, '');
  return siteUrl === PRODUCTION_SITE_URL ? 'production' : 'development';
}

/**
 * The options the Worker's entry point hands to `Sentry.withSentry`.
 *
 * `release` resolves to SENTRY_RELEASE or 'unknown': COMMIT_REF and COMMIT_SHA were build-time
 * variables that never reached a deployed function, and nothing at runtime carries the deployed
 * commit. Setting SENTRY_RELEASE at deploy time is what would make these events agree with the
 * web bundle's, whose maps scripts/sentry-sourcemaps.sh uploads under the commit SHA.
 */
export function sentryOptions(): { dsn: string | undefined; environment: string; release: string; tracesSampleRate: number } {
  return {
    dsn: process.env.SENTRY_DSN,
    environment: resolveSentryEnvironment(),
    release: process.env.SENTRY_RELEASE || 'unknown',
    tracesSampleRate: 0.0, // no performance tracing — only error/message events
  };
}

/** True when a DSN is configured, i.e. when captures have somewhere to go. */
export function isSentryInitialized(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

/**
 * Events captured since the last flush. Lets `withSentry` skip the flush (and its wait) on the
 * common path where an invocation reported nothing.
 */
let unflushedEvents = 0;

/**
 * The Sentry API the functions use: @sentry/cloudflare as-is, except that the two capture calls
 * also count what they queue, so `withSentry` knows when a flush is owed.
 */
export const Sentry = {
  ...SentryCloudflare,
  captureException(...args: Parameters<typeof SentryCloudflare.captureException>) {
    unflushedEvents++;
    return SentryCloudflare.captureException(...args);
  },
  captureMessage(...args: Parameters<typeof SentryCloudflare.captureMessage>) {
    unflushedEvents++;
    return SentryCloudflare.captureMessage(...args);
  },
};

/**
 * Wrap every function's exported handler in this: `export const handler = withSentry(handleRequest)`.
 *
 * Why the flush: Sentry sends events in the background, and an invocation can be torn down as
 * soon as it has answered — on Lambda the process froze outright, which is how server-side
 * errors went missing from Sentry entirely. So before returning, wait (at most 2s) for anything
 * this invocation captured to go out. Invocations that captured nothing skip the wait. On Workers
 * the entry point's `Sentry.withSentry` also flushes through `waitUntil`, so this is now a belt
 * as well as braces — and it is what keeps the behaviour identical while Netlify stays up for
 * rollback.
 *
 * It also reports an error the handler throws, then rethrows it so the caller still answers 500.
 * (When a wrapped handler calls another wrapped handler, as the v1 endpoints do, Sentry
 * recognises the same error object and sends it once.)
 */
export function withSentry<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    } finally {
      if (isSentryInitialized() && unflushedEvents > 0) {
        unflushedEvents = 0;
        await SentryCloudflare.flush(2000);
      }
    }
  };
}
