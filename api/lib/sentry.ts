/**
 * Server-side Sentry, on both runtimes.
 *
 * Reads SENTRY_DSN from the environment. If unset, every capture is a no-op — functions work the
 * same without it. Functions must export their handler through `withSentry` (below);
 * `with-sentry.test.ts` fails on one that forgets.
 *
 * **Two runtimes, two SDKs, one import.** This file imports `@sentry/node`, and wrangler's
 * `alias` swaps in `@sentry/cloudflare` when it bundles the Worker (the same mechanism the edge
 * pages use for Supabase). That is deliberate rather than tidy, because the two SDKs create
 * their client differently and getting it wrong fails *silently*:
 *
 * - **On Node** — Netlify, which is production until the cutover and the rollback path for two
 *   weeks after, plus `npm run dev`, the scripts and CI — `init()` binds the client, and nothing
 *   else will. Importing only `@sentry/cloudflare` here meant no client was ever bound off
 *   Workers: `captureException` queued into nothing and `flush()` returned false, with
 *   `isSentryInitialized()` still reporting true because the DSN was set. That was caught in
 *   review before it shipped; it would have dropped every server-side event the day it merged,
 *   the same silent-loss class as the 2026-08-10 outage the environment note below describes.
 * - **On Workers** `@sentry/cloudflare` has no `init()` at all. Its client is created per
 *   request by the `Sentry.withSentry` wrapper around the Worker's default export
 *   (workers/index.ts), which is also what ties flushing to `waitUntil`.
 *
 * So `initSentry()` calls `init()` only where it exists, and `withSentry()` below flushes only
 * where this file owns the client. Delete the alias and this split at the cutover, once Netlify
 * is retired and `@sentry/cloudflare` can simply be imported.
 *
 * Set in the environment:
 *   SENTRY_DSN = https://…@o4510896048242688.ingest.us.sentry.io/4511275115151360
 *   SENTRY_ENV = production  (optional; see resolveSentryEnvironment)
 */

import * as SentrySDK from '@sentry/node';

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

/**
 * True once this file has bound a Sentry client — i.e. on Node, with a DSN set.
 *
 * It reports what it did, not what was configured. An earlier revision returned
 * `Boolean(process.env.SENTRY_DSN)`, which read as healthy on a runtime where no client existed
 * and nothing was being sent.
 */
export function isSentryInitialized(): boolean {
  return nodeClientActive;
}

/**
 * Whether this module created the client, which is true only on Node.
 *
 * It gates the flush below: on Workers the entry point's `Sentry.withSentry` owns the client and
 * flushes it through `waitUntil`, so flushing here would be both redundant and wrong — the
 * counter it reads is module-level, and one isolate serves many requests at once.
 */
let nodeClientActive = false;

/**
 * Bind a client. Called once on import, which is all Node needs.
 *
 * `init` exists only in `@sentry/node`; under the Worker's alias this is `@sentry/cloudflare`,
 * which has none, so this is a no-op there and `Sentry.withSentry` does the work instead.
 */
export function initSentry(): void {
  if (nodeClientActive) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (typeof SentrySDK.init !== 'function') return;

  SentrySDK.init(sentryOptions());
  nodeClientActive = true;
}

/**
 * Events captured since the last flush. Lets `withSentry` skip the flush (and its wait) on the
 * common path where an invocation reported nothing.
 *
 * Only ever touched on Node, where one invocation owns the process. On Workers it stays at zero:
 * a module-level counter is shared by every request an isolate is handling at once, so counting
 * there would let one request's flush clear another's pending events — and nothing reads it,
 * because `Sentry.withSentry` in the entry point owns flushing.
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
 * Node only. On Workers the entry point's `Sentry.withSentry` owns the client and flushes it
 * through `waitUntil`; flushing here as well would read a counter shared across every request in
 * the isolate.
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

// Bind the client on import, which is what Node needs and all it needs. A no-op on Workers,
// where `init` doesn't exist and `Sentry.withSentry` creates the client per request instead.
initSentry();
