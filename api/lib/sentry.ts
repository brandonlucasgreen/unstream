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
 * Server-side events will appear in the same Sentry project but are
 * distinguishable via `platform: 'node'` in the Sentry UI.
 *
 * Set the env var in Netlify UI:
 *   SENTRY_DSN = https://a1c8d202cd8df4fc88a2fd54f2e4490b@o4510896048242688.ingest.us.sentry.io/4511275115151360
 *   SENTRY_ENV  = production  (or staging, etc.)
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    // No DSN → Sentry stays uninitialized. captureException / captureMessage
    // become no-ops, so functions work fine without it.
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'development',
    // Netlify provides COMMIT_REF (branch/ref) in all deploys; COMMIT_SHA is
    // not standard. Fall back through COMMIT_REF → COMMIT_SHA → 'unknown'
    // so version tracking works reliably on Netlify.
    release: process.env.COMMIT_REF || process.env.COMMIT_SHA || 'unknown',
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

export { Sentry };