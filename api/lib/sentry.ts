/**
 * Server-side Sentry for the Netlify functions.
 *
 * Reads SENTRY_DSN from the environment. If unset, every capture is a no-op — functions work the
 * same without it. Functions must export their handler through `withSentry` (below);
 * `with-sentry.test.ts` fails on one that forgets.
 *
 * **`init()` is what binds the client, and nothing else will.** An earlier revision imported a
 * different Sentry SDK here, under which no client was ever bound on Node: `captureException`
 * queued into nothing and `flush()` returned false, with `isSentryInitialized()` still reporting
 * true because the DSN was set. That was caught in review before it shipped; it would have dropped
 * every server-side event, the same silent-loss class as the 2026-08-10 outage the environment
 * note below describes. `sentry-client-binding.test.ts` pins it.
 *
 * Set in the environment:
 *   SENTRY_DSN = https://…@o4510896048242688.ingest.us.sentry.io/4511275115151360
 *   SENTRY_ENV = production  (optional; see resolveSentryEnvironment)
 */

import * as SentrySDK from '@sentry/node';
import { isProductionSite } from './production-site';

/**
 * Which environment to tag events with.
 *
 * `SENTRY_ENV` wins when it's set, but it isn't set on this site, and the old fallback chain
 * (`NODE_ENV` → `'development'`) meant every production function error arrived tagged
 * `environment: development`. That isn't cosmetic: it reads as "someone's laptop" and buys a
 * real outage another day of being ignored. The 29-hour release-alert outage of 2026-08-10 was
 * reported exactly that way.
 *
 * `URL` is the signal (api/lib/production-site.ts): Netlify sets it to the site's address, and
 * under `npm run dev` it is localhost, so local runs still tag as development.
 */
export function resolveSentryEnvironment(): string {
  const explicit = process.env.SENTRY_ENV;
  if (explicit) return explicit;

  return isProductionSite() ? 'production' : 'development';
}

/**
 * The options `initSentry()` binds the client with.
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

/**
 * True once this file has bound a Sentry client, i.e. a DSN was set.
 *
 * It reports what it did, not what was configured. An earlier revision returned
 * `Boolean(process.env.SENTRY_DSN)`, which read as healthy on a runtime where no client existed
 * and nothing was being sent.
 */
export function isSentryInitialized(): boolean {
  return nodeClientActive;
}

/** Whether this module created the client; gates the flush below. */
let nodeClientActive = false;

/** Bind a client. Called once on import, which is all a function needs. */
export function initSentry(): void {
  if (nodeClientActive) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  SentrySDK.init(sentryOptions());
  nodeClientActive = true;
}

/**
 * Events captured since the last flush. Lets `withSentry` skip the flush (and its wait) on the
 * common path where an invocation reported nothing.
 */
let unflushedEvents = 0;

/**
 * The Sentry API the functions use: the SDK as-is, except that the two capture calls also count
 * what they queue, so `withSentry` knows when a flush is owed.
 */
export const Sentry = {
  ...SentrySDK,
  captureException(...args: Parameters<typeof SentrySDK.captureException>) {
    if (nodeClientActive) unflushedEvents++;
    return SentrySDK.captureException(...args);
  },
  captureMessage(...args: Parameters<typeof SentrySDK.captureMessage>) {
    if (nodeClientActive) unflushedEvents++;
    return SentrySDK.captureMessage(...args);
  },
};

/**
 * Wrap every function's exported handler in this: `export const handler = withSentry(handleRequest)`.
 *
 * Why the flush: Sentry sends events in the background, and an invocation can be torn down as
 * soon as it has answered — on Lambda the process froze outright, which is how server-side
 * errors went missing from Sentry entirely. So before returning, wait (at most 2s) for anything
 * this invocation captured to go out. Invocations that captured nothing skip the wait.
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
      if (nodeClientActive && unflushedEvents > 0) {
        unflushedEvents = 0;
        await SentrySDK.flush(2000);
      }
    }
  };
}

// Bind the client on import.
initSentry();
