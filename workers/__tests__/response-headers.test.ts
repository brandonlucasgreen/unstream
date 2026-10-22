import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { withSiteHeaders } from '../response-headers.ts';

/**
 * The CSP is stated twice, and has to agree.
 *
 * Static files are served without running the Worker — that is what makes them free — so they
 * get their headers from `apps/web/public/_headers`, and a server-rendered page, which never
 * passes through that file, gets them from `withSiteHeaders`. Two copies is the price of not
 * billing a Worker request for every asset; this test is what stops them drifting, which is a
 * failure that shows up as a silently weaker CSP rather than as an error.
 *
 * The two cache rules are only in `_headers`, since the files they name are always real assets
 * and never reach the Worker. They are pinned here because their values are load-bearing.
 */
const headersFile = readFileSync(join(__dirname, '..', '..', 'apps', 'web', 'public', '_headers'), 'utf8');

function headerFromFile(section: string, name: string): string | undefined {
  const lines = headersFile.split('\n');
  const start = lines.findIndex((line) => line.trim() === section);
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('  ')) break;
    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (match && match[1].toLowerCase() === name.toLowerCase()) return match[2];
  }
  return undefined;
}

function workerHeader(name: string): string | null {
  return withSiteHeaders(new Response('x'), 'https://unstream.stream').headers.get(name);
}

describe('the Worker and _headers agree on the CSP', () => {
  it('states the same policy in both places', () => {
    const fromFile = headerFromFile('/*', 'Content-Security-Policy');
    expect(fromFile).toBeDefined();
    expect(workerHeader('Content-Security-Policy')).toBe(fromFile);
  });
});

describe('_headers keeps the two files that must never be answered from a stale cache', () => {
  it('/build-id.json, the staleness detector', () => {
    // A cached response would echo a tab's own build back to it forever, so the banner that
    // tells someone to refresh would never appear.
    expect(headerFromFile('/build-id.json', 'Cache-Control')).toBe('no-store, max-age=0');
  });

  it('/sw.js, which is how a stale build gets resolved', () => {
    // The browser discovers a new service worker only by re-fetching this. On 2026-08-24 a
    // Safari session was pinned to a build whose /assets/* had all been deleted, running that
    // dead code until it threw.
    expect(headerFromFile('/sw.js', 'Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });
});

describe('the CSP still carries the hosts that were lost once before', () => {
  const csp = workerHeader('Content-Security-Policy')!;

  it('allows Sentry’s region-scoped ingest host', () => {
    // `*.ingest.sentry.io` does NOT cover `o….ingest.us.sentry.io`: CSP host wildcards are a
    // suffix match. That missing `us.` silently dropped every browser error event until 2026-08-01.
    expect(csp).toContain('https://*.ingest.us.sentry.io');
  });

  it('allows both coollabs font hosts, which are different origins', () => {
    // The stylesheet comes from api.fonts.coollabs.io; the .woff2 files it references come from
    // cdn.fonts.coollabs.io. Getting this wrong fails silently — every page falls back to system-ui.
    expect(csp).toContain('style-src');
    expect(csp).toContain('api.fonts.coollabs.io');
    expect(csp).toContain('font-src cdn.fonts.coollabs.io');
  });
});

describe('withSiteHeaders', () => {
  it('keeps the response’s own headers, status and body', async () => {
    const original = new Response('{"ok":true}', {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'abc' },
    });

    const result = withSiteHeaders(original, 'https://unstream.stream');

    expect(result.status).toBe(201);
    expect(result.headers.get('x-request-id')).toBe('abc');
    expect(await result.text()).toBe('{"ok":true}');
  });

  it('works on a response whose headers are immutable', () => {
    // A response from the static-asset binding has immutable headers, so this must not mutate.
    const immutable = Response.redirect('https://unstream.stream/support', 301);
    expect(() => withSiteHeaders(immutable, 'https://unstream.stream')).not.toThrow();
  });
});

describe('only the real site is indexable', () => {
  // Staging and workers.dev serve production's data in full; indexed, they would be a second copy
  // of every artist and release page.
  it.each([
    ['staging', 'https://next.unstream.stream'],
    ['the workers.dev address', 'https://unstream.example.workers.dev'],
    ['wrangler dev', 'http://localhost:8787'],
  ])('marks %s noindex', (_where, origin) => {
    expect(withSiteHeaders(new Response('x'), origin).headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('leaves unstream.stream indexable', () => {
    expect(withSiteHeaders(new Response('x'), 'https://unstream.stream').headers.get('X-Robots-Tag')).toBeNull();
  });
});
