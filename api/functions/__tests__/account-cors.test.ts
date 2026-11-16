import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every endpoint a signed-in person calls with a Bearer token answers with an allowlisted
 * `Access-Control-Allow-Origin`, never `*` (account-cors.ts says why). One table covers them
 * all, so an endpoint added to the table is held to the same answers as the rest, and the scan
 * at the bottom fails on a new function that takes a token and hand-rolls a wildcard.
 */

// Nothing here reaches Redis, Supabase or Stripe: each request below is either a preflight or
// arrives with no Authorization header, so the handlers stop at "not signed in".
vi.mock('../ratelimit', () => ({
  checkRateLimit: async () => ({ limited: false }),
  resolveAccountRequest: async () => ({ key: 'ip:127.0.0.1', user: null }),
  accountRateLimitKey: async () => 'ip:127.0.0.1',
  checkSentryDedup: async () => false,
  getClientIp: () => '127.0.0.1',
}));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getClient: () => ({}),
}));

import { buildAccountCorsHeaders } from '../account-cors';

type Handler = (event: never) => Promise<{ statusCode: number; headers?: unknown } | null | undefined | void>;

interface Endpoint {
  name: string;
  /** The Access-Control-Allow-Methods this endpoint answered with before the move, unchanged. */
  methods: string;
  /** True only where the browser extension's popup calls: its own origin is echoed there. */
  extension?: true;
  load: () => Promise<{ handler: unknown }>;
}

const ENDPOINTS: Endpoint[] = [
  { name: 'me-collection', methods: 'GET, POST, OPTIONS', load: () => import('../me-collection') },
  { name: 'me-bandcamp', methods: 'GET, POST, DELETE, OPTIONS', load: () => import('../me-bandcamp') },
  { name: 'me-listening', methods: 'GET, POST, DELETE, OPTIONS', load: () => import('../me-listening') },
  { name: 'me-location', methods: 'GET, POST, OPTIONS', load: () => import('../me-location') },
  { name: 'me-feed-token', methods: 'GET, POST, DELETE, OPTIONS', load: () => import('../me-feed-token') },
  { name: 'me-recent-releases', methods: 'GET, OPTIONS', load: () => import('../me-recent-releases') },
  { name: 'me-password', methods: 'POST, OPTIONS', load: () => import('../me-password') },
  { name: 'me-notifications', methods: 'GET, POST, OPTIONS', load: () => import('../me-notifications') },
  { name: 'me-username', methods: 'POST, OPTIONS', load: () => import('../me-username') },
  { name: 'me-tips', methods: 'GET, POST, OPTIONS', load: () => import('../me-tips') },
  { name: 'saved-artists', methods: 'GET, POST, OPTIONS', extension: true, load: () => import('../saved-artists') },
  { name: 'saved-artists-sync', methods: 'GET, OPTIONS', extension: true, load: () => import('../saved-artists-sync') },
  { name: 'user-sharing', methods: 'GET, POST, OPTIONS', load: () => import('../user-sharing') },
  { name: 'artist-profile', methods: 'PUT, DELETE, OPTIONS', load: () => import('../artist-profile') },
  { name: 'claim-artist', methods: 'POST, OPTIONS', load: () => import('../claim-artist') },
  { name: 'artist-auth', methods: 'GET, POST, OPTIONS', load: () => import('../artist-auth') },
  { name: 'analytics-stats', methods: 'GET, OPTIONS', load: () => import('../analytics-stats') },
  { name: 'admin-merge-override', methods: 'POST, OPTIONS', load: () => import('../admin-merge-override') },
  { name: 'tips-connect', methods: 'GET, POST, PUT, OPTIONS', load: () => import('../tips-connect') },
  { name: 'tips-settings', methods: 'GET, POST, PUT, OPTIONS', load: () => import('../tips-settings') },
];

const SITE = 'https://unstream.stream';
const FOREIGN = 'https://evil.example';
const LOCAL_DEV = 'http://localhost:8888';
const CHROME_EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const FIREFOX_EXTENSION = 'moz-extension://2c127fa4-62c7-4e9c-9d2e-1f0a3c1e8a11';

async function ask(endpoint: Endpoint, httpMethod: string, origin: string | undefined) {
  const { handler } = await endpoint.load();
  const response = await (handler as Handler)({
    httpMethod,
    headers: origin ? { origin } : {},
    body: null,
    queryStringParameters: {},
  } as never);
  return {
    statusCode: response!.statusCode,
    headers: response!.headers as Record<string, string>,
  };
}

describe.each(ENDPOINTS)('$name', (endpoint) => {
  // The first method the endpoint really serves: the request a signed-out caller would make.
  const realMethod = endpoint.methods.split(', ')[0];

  it('does not echo a foreign origin, on the preflight or on a real answer', async () => {
    for (const method of ['OPTIONS', realMethod]) {
      const { headers } = await ask(endpoint, method, FOREIGN);
      expect(headers['Access-Control-Allow-Origin']).toBe(SITE);
      // These endpoints authorize with a Bearer token; the browser must not be invited to send cookies.
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    }
  });

  it('echoes the local dev origin, on the preflight and on a real answer', async () => {
    for (const method of ['OPTIONS', realMethod]) {
      const { headers } = await ask(endpoint, method, LOCAL_DEV);
      expect(headers['Access-Control-Allow-Origin']).toBe(LOCAL_DEV);
    }
  });

  it('answers a caller that sends no Origin (the Mac and iOS apps) without a wildcard', async () => {
    const { headers } = await ask(endpoint, realMethod, undefined);
    expect(headers['Access-Control-Allow-Origin']).toBe(SITE);
  });

  it('keeps the methods and headers it allowed before', async () => {
    const { statusCode, headers } = await ask(endpoint, 'OPTIONS', SITE);
    expect(statusCode).toBe(204);
    expect(headers['Access-Control-Allow-Methods']).toBe(endpoint.methods);
    expect(headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
    expect(headers['Vary']).toBe('Origin');
  });

  it(endpoint.extension ? "echoes the browser extension's own origin" : "does not echo a browser extension's origin", async () => {
    for (const origin of [CHROME_EXTENSION, FIREFOX_EXTENSION]) {
      for (const method of ['OPTIONS', realMethod]) {
        const { headers } = await ask(endpoint, method, origin);
        expect(headers['Access-Control-Allow-Origin']).toBe(endpoint.extension ? origin : SITE);
      }
    }
  });
});

describe('buildAccountCorsHeaders', () => {
  it('never answers with a wildcard, whatever the origin', () => {
    for (const origin of [undefined, '', '*', 'null', FOREIGN, CHROME_EXTENSION]) {
      expect(buildAccountCorsHeaders(origin, 'GET, OPTIONS')['Access-Control-Allow-Origin']).toBe(SITE);
    }
  });

  it('echoes an extension origin only when asked to, and only a real one', () => {
    const allow = (origin: string) =>
      buildAccountCorsHeaders(origin, 'GET, OPTIONS', { allowExtensionOrigins: true })['Access-Control-Allow-Origin'];

    expect(allow(CHROME_EXTENSION)).toBe(CHROME_EXTENSION);
    expect(allow(FIREFOX_EXTENSION)).toBe(FIREFOX_EXTENSION);
    // A web page can name itself after the scheme, but it can't present the scheme.
    expect(allow('https://chrome-extension.evil.example')).toBe(SITE);
    expect(allow('https://evil.example/chrome-extension://abc')).toBe(SITE);
    expect(allow('chrome-extension://abc.evil.example')).toBe(SITE);
    expect(allow(FOREIGN)).toBe(SITE);
  });
});

describe('no function that takes a Bearer token hand-rolls a wildcard origin', () => {
  const functionsDir = join(__dirname, '..');
  const WILDCARD = /'Access-Control-Allow-Origin':\s*'\*'/;
  const TAKES_BEARER = /authenticateBearer|authenticateAdmin|resolveAccountRequest|accountRateLimitKey|sessionMissingSecondFactor|headers\??\.[aA]uthorization|headers\??\[['"][aA]uthorization['"]\]/;

  /** The deliberate exceptions. Each file's own comment says why its wildcard stays. */
  const EXCEPTIONS = new Set([
    // Defines the public and API-key builders; it answers no request itself.
    'middleware.ts',
    // A CDN-cached image loaded through <img>; the Bearer path is for non-browser clients.
    'collection-art.ts',
  ]);

  const offenders = readdirSync(functionsDir)
    .filter((name) => name.endsWith('.ts') && !EXCEPTIONS.has(name))
    .filter((name) => {
      const source = readFileSync(join(functionsDir, name), 'utf8');
      return WILDCARD.test(source) && TAKES_BEARER.test(source);
    });

  it('finds none outside the documented exceptions', () => {
    expect(offenders).toEqual([]);
  });

  it('still needs each exception', () => {
    for (const name of EXCEPTIONS) {
      expect(readFileSync(join(functionsDir, name), 'utf8')).toMatch(WILDCARD);
    }
  });
});
