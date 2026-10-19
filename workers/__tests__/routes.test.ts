import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROUTES, matchPattern, matchRoute } from '../routes.ts';

/**
 * The Worker's route table replaced netlify.toml's redirects and edge-function entries. While
 * netlify.toml is still in the repository — it stays until the Netlify site is retired after the
 * cutover window — it is the thing to check against: a route that was dropped in the port would
 * otherwise show up as a 404 in production and nowhere else.
 *
 * These tests go when netlify.toml does.
 */
const repoRoot = join(__dirname, '..', '..');
const netlifyToml = readFileSync(join(repoRoot, 'netlify.toml'), 'utf8');

function redirectEntries(): { from: string; to: string; status: number }[] {
  return netlifyToml
    .split('[[redirects]]')
    .slice(1)
    .map((block) => ({
      from: block.match(/from\s*=\s*"([^"]+)"/)![1],
      to: block.match(/to\s*=\s*"([^"]+)"/)![1],
      status: Number(block.match(/status\s*=\s*(\d+)/)![1]),
    }));
}

describe('every netlify.toml redirect still has a route', () => {
  const entries = redirectEntries();

  it('finds the redirects', () => {
    expect(entries.length).toBeGreaterThan(60);
  });

  it.each(entries.map((e) => [e.from, e] as const))('%s', (_from, entry) => {
    const route = ROUTES.find((r) => r.pattern === entry.from);
    expect(route, `no route for ${entry.from}`).toBeDefined();

    const functionName = entry.to.match(/^\/\.netlify\/functions\/([a-z0-9-]+)$/)?.[1];
    if (functionName) {
      expect(route).toMatchObject({ kind: 'function', name: functionName });
    } else if (entry.status === 301) {
      expect(route).toMatchObject({ kind: 'redirect', to: entry.to, status: 301 });
    } else if (entry.status === 404) {
      expect(route).toMatchObject({ kind: 'missing-asset' });
    } else {
      expect(route).toMatchObject({ kind: 'spa' });
    }
  });
});

describe('every netlify.toml edge function still has a route', () => {
  const names = [...netlifyToml.matchAll(/function\s*=\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(names)];

  it('finds the edge functions', () => {
    expect(unique).toHaveLength(7);
  });

  it.each(unique)('%s', (name) => {
    expect(ROUTES.some((r) => r.kind === 'edge' && r.name === name)).toBe(true);
  });
});

describe('every routed function name is a file on disk', () => {
  const functionFiles = new Set(
    readdirSync(join(repoRoot, 'api', 'functions'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replace(/\.ts$/, '')),
  );

  it.each(ROUTES.filter((r) => r.kind === 'function').map((r) => (r as { name: string }).name))(
    '%s',
    (name) => {
      expect(functionFiles.has(name)).toBe(true);
    },
  );
});

describe('matchPattern', () => {
  it('matches a literal path, with or without a trailing slash', () => {
    expect(matchPattern('/api/me/tips', '/api/me/tips')).toEqual({});
    expect(matchPattern('/api/me/tips', '/api/me/tips/')).toEqual({});
    expect(matchPattern('/api/me/tips', '/api/me/tips/extra')).toBeNull();
  });

  it('matches a trailing splat against the prefix and anything under it', () => {
    expect(matchPattern('/api/v1/artist/*', '/api/v1/artist')).toEqual({});
    expect(matchPattern('/api/v1/artist/*', '/api/v1/artist/radiohead')).toEqual({});
    expect(matchPattern('/api/v1/artist/*', '/api/v1/artists')).toBeNull();
  });

  it('captures :name segments and requires each one to be filled', () => {
    expect(matchPattern('/a/:artist/:release', '/a/mono/hymn')).toEqual({ artist: 'mono', release: 'hymn' });
    expect(matchPattern('/a/:artist/:release', '/a/mono')).toBeNull();
    expect(matchPattern('/a/:artist/:release', '/a/mono/hymn/extra')).toBeNull();
  });

  it('decodes a captured segment', () => {
    expect(matchPattern('/u/:handle', '/u/caf%C3%A9')).toEqual({ handle: 'café' });
  });

  it('matches the root only against itself', () => {
    expect(matchPattern('/', '/')).toEqual({});
    expect(matchPattern('/', '/search')).toBeNull();
  });
});

describe('route order', () => {
  /**
   * Both of these were load-bearing on Netlify and are load-bearing here, for the same reasons:
   * a feed answered by a page renderer hands a calendar client HTML, and a release page answered
   * by the artist renderer costs a database query per view and only works by accident.
   */
  it('answers a release feed with the feed function, not the artist page', () => {
    expect(matchRoute('/a/mono/releases.xml')?.route).toMatchObject({ kind: 'function', name: 'feed-releases' });
    expect(matchRoute('/a/mono/releases.ics')?.route).toMatchObject({ kind: 'function', name: 'feed-releases' });
    expect(matchRoute('/u/brandon/releases.xml')?.route).toMatchObject({ kind: 'function', name: 'feed-releases' });
  });

  it('answers a release page with the release renderer, and an artist page with the artist one', () => {
    expect(matchRoute('/a/mono/hymn-to-the-immortal-wind')?.route).toMatchObject({ kind: 'edge', name: 'release-page' });
    expect(matchRoute('/a/mono')?.route).toMatchObject({ kind: 'edge', name: 'artist-page-static' });
    expect(matchRoute('/artist/mono')?.route).toMatchObject({ kind: 'edge', name: 'artist-page-static' });
  });

  it('answers an API path with its function rather than the SPA catch-all', () => {
    expect(matchRoute('/api/search/sources')?.route).toMatchObject({ kind: 'function', name: 'search-sources' });
    expect(matchRoute('/appcast.xml')?.route).toMatchObject({ kind: 'function', name: 'desktop-appcast' });
  });

  it('sends an unknown page to the SPA', () => {
    expect(matchRoute('/dashboard')?.route).toMatchObject({ kind: 'spa' });
  });

  it('keeps the retired guides redirects, specific slugs before the catch-all', () => {
    expect(matchRoute('/guides/every-platform-unstream-supports-compared')?.route).toMatchObject({
      kind: 'redirect',
      to: '/platforms',
    });
    expect(matchRoute('/guides/anything-else')?.route).toMatchObject({ kind: 'redirect', to: '/faq' });
  });

  it('404s a missing build asset instead of handing back the SPA shell', () => {
    expect(matchRoute('/assets/index-abc123.js')?.route).toMatchObject({ kind: 'missing-asset' });
  });
});
