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
 *
 * Environment tagging used to fall back to `NODE_ENV`, which Netlify Functions never set at
 * runtime (same gotcha as `CONTEXT` in request-catalog.ts — it's a build-time-only variable),
 * so every deployed function reported `environment: development` regardless of context. `URL`
 * *is* exposed to functions at runtime, so that's what production detection is based on now.
 * `SENTRY_ENV` still wins when set, for anyone who wants an explicit override (e.g. `staging`).
 */

import * as Sentry from '@sentry/node';

const PRODUCTION_HOSTNAME = 'unstream.stream';

/**
 * `SENTRY_ENV` overrides everything else. Otherwise: no `URL` means a non-Netlify runtime
 * (local `npm run dev`, a test run) → `development`; `URL` matching the production domain →
 * `production`; any other `URL` (a `*.netlify.app` deploy preview or branch deploy) → `preview`.
 */
function detectEnvironment(): string {
  if (process.env.SENTRY_ENV) return process.env.SENTRY_ENV;

  const url = process.env.URL;
  if (!url) return 'development';
  return url.includes(PRODUCTION_HOSTNAME) ? 'production' : 'preview';
}

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
    environment: detectEnvironment(),
    // SENTRY_RELEASE takes priority if set in Netlify (allows pinning release names
    // independent of build SHA). Fall back through SENTRY_RELEASE → COMMIT_REF →
    // COMMIT_SHA → 'unknown' so version tracking works reliably on Netlify.
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

export { Sentry };