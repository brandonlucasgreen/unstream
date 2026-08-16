import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { resolveSentryEnvironment } from '../../lib/sentry';

/**
 * The 29-hour release-alert outage of 2026-08-10 (`column releases.alert_sent_at does not exist`,
 * every catalog run, production) was reported by Sentry as `environment: development`. The old
 * fallback chain was `SENTRY_ENV || NODE_ENV || 'development'`, and a deployed Netlify function
 * has neither variable — so production could not produce any other answer.
 *
 * These tests pin the runtime signal that can tell the difference. Note the last one: it fails
 * against the old chain, which is the whole point.
 */
describe('resolveSentryEnvironment', () => {
  const saved = { SENTRY_ENV: process.env.SENTRY_ENV, NODE_ENV: process.env.NODE_ENV, URL: process.env.URL };

  beforeEach(() => {
    delete process.env.SENTRY_ENV;
    delete process.env.NODE_ENV;
    delete process.env.URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prefers an explicit SENTRY_ENV over anything derived', () => {
    process.env.SENTRY_ENV = 'staging';
    process.env.URL = 'https://unstream.stream';
    expect(resolveSentryEnvironment()).toBe('staging');
  });

  it('tags the production site as production', () => {
    process.env.URL = 'https://unstream.stream';
    expect(resolveSentryEnvironment()).toBe('production');
  });

  it('tolerates a trailing slash on the site URL', () => {
    process.env.URL = 'https://unstream.stream/';
    expect(resolveSentryEnvironment()).toBe('production');
  });

  it('tags a netlify dev run as development', () => {
    process.env.URL = 'http://localhost:8888';
    expect(resolveSentryEnvironment()).toBe('development');
  });

  it('tags an unknown environment as development', () => {
    expect(resolveSentryEnvironment()).toBe('development');
  });

  // The regression itself: production functions see no SENTRY_ENV and no NODE_ENV. Under the old
  // chain this case returned 'development', which is how a production outage came in looking
  // like someone's laptop.
  it('does not fall back to development just because SENTRY_ENV and NODE_ENV are unset', () => {
    process.env.URL = 'https://unstream.stream';
    expect(process.env.SENTRY_ENV).toBeUndefined();
    expect(process.env.NODE_ENV).toBeUndefined();
    expect(resolveSentryEnvironment()).toBe('production');
  });
});
