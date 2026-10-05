/**
 * Server-side Sentry initialization for Netlify Functions.
 *
 * Reads SENTRY_DSN from the environment. If set, initializes Sentry so that
 * api functions can call Sentry.captureException / Sentry.captureMessage.
 * If unset, the exported Sentry instance is a no-op stub — functions still
 * work without any Sentry dependency at runtime.
 *
 * The DSN can be the same one used by the web client:
 *   https://a1c8d202cd8df4fc88a2fd54f2e4490b@o4510896048242688.ingest.us.sentry.io/4511275115151360
 *
 * Functions must export their handler through `withSentry` (below), or events captured just
 * before a function returns are lost when Lambda freezes the process.
 *
 * Server-side events will appear in the same Sentry project but are
 * distinguishable via `platform: 'node'` in the Sentry UI.
 *
 * Set the env var in Netlify UI:
 *   SENTRY_DSN = https://a1c8d202cd8df4fc88a2fd54f2e4490b@o4510896048242688.ingest.us.sentry.io/4511275115151360
 *   SENTRY_ENV  = production  (or staging, etc.)
 */

import * as SentryNode from '@sentry/node';

const PRODUCTION_SITE_URL = 'https://unstream.stream';

let initialized = false;

/**
 * Which environment to tag events with.
 *
 * `SENTRY_ENV` wins when it's set, but it isn't set on this site, and the old fallback chain
 * (`NODE_ENV` → `'development'`) meant every production function error arrived tagged
 * `environment: development`. That isn't cosmetic: it reads as "someone's laptop" and buys a
 * real outage another day of being ignored. The 29-hour release-alert outage of 2026-08-10 was
 * reported exactly that way.
 *
 * `URL` is the signal because it is one of the three variables Netlify actually exposes to a
 * function at runtime (`URL`, `SITE_NAME`, `SITE_ID`) — the same reason `request-catalog.ts`
 * uses it. `CONTEXT` and `DEPLOY_PRIME_URL` are build-time only and are `undefined` here, so
 * neither can be used to tell production from anything else. Under `netlify dev`, `URL` is the
 * localhost origin, so local runs still tag as development.
 */
export function resolveSentryEnvironment(): string {
  const explicit = process.env.SENTRY_ENV;
  if (explicit) return explicit;

  const siteUrl = process.env.URL?.replace(/\/$/, '');
  return siteUrl === PRODUCTION_SITE_URL ? 'production' : 'development';
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    // No DSN → Sentry stays uninitialized. captureException / captureMessage
    // become no-ops, so functions work fine without it.
    return;
  }

  SentryNode.init({
    dsn,
    environment: resolveSentryEnvironment(),
    // COMMIT_REF and COMMIT_SHA are build-time variables and never reach a deployed function, so
    // at runtime this resolves to SENTRY_RELEASE or 'unknown'. The chain stays because
    // scripts/sentry-sourcemaps.sh deliberately mirrors it — but note that the mirror only holds
    // for the web bundle: at build time that script resolves COMMIT_REF and uploads maps under
    // the commit SHA, while these server-side events arrive tagged 'unknown'. Setting
    // SENTRY_RELEASE in Netlify is what would make both ends agree; no runtime variable carries
    // the deployed commit.
    release: process.env.SENTRY_RELEASE || process.env.COMMIT_REF || process.env.COMMIT_SHA || 'unknown',
    tracesSampleRate: 0.0, // no performance tracing — only error/message events
  });

  initialized = true;
}

/** Returns true if Sentry was initialized (i.e., SENTRY_DSN was set). */
export function isSentryInitialized(): boolean {
  return initialized;
}

// Auto-init on first import so that any function that imports Sentry
// gets a ready-to-use instance without boilerplate.
initSentry();

/**
 * Events captured since the last flush. Lets `withSentry` skip the flush (and its wait) on the
 * common path where an invocation reported nothing.
 */
let unflushedEvents = 0;

/**
 * The Sentry API the functions use: @sentry/node as-is, except that the two capture calls also
 * count what they queue, so `withSentry` knows when a flush is owed.
 */
export const Sentry = {
  ...SentryNode,
  captureException(...args: Parameters<typeof SentryNode.captureException>) {
    unflushedEvents++;
    return SentryNode.captureException(...args);
  },
  captureMessage(...args: Parameters<typeof SentryNode.captureMessage>) {
    unflushedEvents++;
    return SentryNode.captureMessage(...args);
  },
};

/**
 * Wrap every Netlify function's exported handler in this: `export const handler = withSentry(handleRequest)`.
 *
 * Why: Sentry sends events in the background, but a Netlify function is an AWS Lambda, and Lambda
 * freezes the process the moment the handler's promise resolves. An event captured just before
 * `return` is still queued at that point and is usually never sent, which is how server-side
 * errors went missing from Sentry entirely. So before returning, wait (at most 2s) for anything
 * this invocation captured to go out. Invocations that captured nothing skip the wait.
 *
 * It also reports an error the handler throws, then rethrows it so Netlify still answers 500.
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
      if (initialized && unflushedEvents > 0) {
        unflushedEvents = 0;
        await SentryNode.flush(2000);
      }
    }
  };
}
