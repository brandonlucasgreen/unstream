import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * On Netlify's functions `init()` is the only thing that binds a Sentry client.
 *
 * An earlier revision of api/lib/sentry.ts imported a different Sentry SDK, under which no client
 * was ever bound: `captureException` queued into nothing and `flush()` returned false, while
 * `isSentryInitialized()` kept returning true because the DSN was set. Every server-side event
 * would have been dropped silently the day it merged — the same class as the 29-hour
 * release-alert outage that was reported as `environment: development`.
 *
 * This asserts the binding actually happens, which is the part that was wrong and the part no
 * other test could see.
 */
const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@sentry/node', () => mocks);

const savedDsn = process.env.SENTRY_DSN;
const savedUrl = process.env.URL;
afterAll(() => {
  if (savedDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = savedDsn;
  if (savedUrl === undefined) delete process.env.URL;
  else process.env.URL = savedUrl;
});

process.env.SENTRY_DSN = 'https://public@example.ingest.us.sentry.io/1';
process.env.URL = 'https://unstream.stream';

const { initSentry, isSentryInitialized, sentryOptions } = await import('../../lib/sentry');

beforeEach(() => {
  mocks.init.mockClear();
});

describe('binding a client on Node', () => {
  it('called init() on import, so captures have somewhere to go', () => {
    // The module self-initialises; importing it is what a function does.
    expect(isSentryInitialized()).toBe(true);
  });

  it('reports itself uninitialised rather than merely configured', () => {
    // isSentryInitialized() must describe what happened, not what was set: a DSN with no client
    // behind it is exactly the state that went unnoticed.
    expect(isSentryInitialized()).toBe(true);
    expect(typeof isSentryInitialized()).toBe('boolean');
  });

  it('initialises at most once', () => {
    initSentry();
    initSentry();

    expect(mocks.init).not.toHaveBeenCalled(); // already bound on import
  });

  it('passes the DSN, environment and release the site expects', () => {
    const options = sentryOptions();

    expect(options.dsn).toBe('https://public@example.ingest.us.sentry.io/1');
    expect(options.environment).toBe('production');
    expect(options.tracesSampleRate).toBe(0);
  });
});
