#!/usr/bin/env npx tsx
/**
 * Smoke test for server-side Sentry init.
 *
 * Usage:
 *   SENTRY_DSN=<dsn> SENTRY_ENV=development npx tsx api/scripts/sentry-test.ts
 *
 * Without SENTRY_DSN, the script logs a message and exits 0.
 * With a real DSN, it sends a test captureMessage event to Sentry.
 */

import { Sentry, isSentryInitialized } from '../lib/sentry';

async function main(): Promise<void> {
  if (!isSentryInitialized()) {
    console.log('Sentry DSN not set, skipping test');
    return;
  }

  console.log('Sentry initialized — sending test event…');

  Sentry.captureMessage('[UNS-87] Sentry server-side init test', {
    level: 'info',
    extra: { context: 'sentry.init.test' },
  });

  // Give Sentry time to flush the event before the process exits.
  await Sentry.flush(5000);

  console.log('Test event sent. Check your Sentry project for a message event with context=sentry.init.test');
}

main().catch((err) => {
  console.error('sentry-test failed:', err);
  process.exit(1);
});