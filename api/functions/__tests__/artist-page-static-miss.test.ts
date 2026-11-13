// What a crawler gets for an /a/:slug that isn't a live artist.
//
// Search Console reported /a/impulse-nine as a soft 404 (2026-11-12). Impulse Nine is stored as
// `impulsenine`; the hyphenated URL was guessed from the name, matched nothing, and the crawler was
// handed the SPA shell answering 200 for "artist not found". Now a guess that names exactly one
// artist redirects there, and a definite miss answers a real 404 with noindex.
//
// Loads the real edge function the way release-page-unavailable.test.ts does: its Deno-only URL
// imports rewritten to local stubs in a temp directory.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

type Handler = (request: Request, context: { next: () => Promise<Response> }) => Promise<Response>;
let handler: Handler;
let setAnswers: (answers: Record<string, { data: unknown; error: unknown }>) => void;
const originalProcessEnv = { ...process.env };

beforeAll(async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'unstream-artist-miss-'));
  // Each query answers whatever the test set for its table, as `{ data, error }`. The name-guess
  // read of `artists` is the one that calls ilike(), so it answers from `artists:guess`.
  writeFileSync(join(stubDir, 'supabase.ts'), `
let answers: Record<string, { data: unknown; error: unknown }> = {};
export function setAnswers(a: Record<string, { data: unknown; error: unknown }>) { answers = a; }
export function createClient() {
  return {
    from(table: string) {
      let key = table;
      const q: any = {
        select: () => q, eq: () => q, order: () => q, limit: () => q, abortSignal: () => q,
        maybeSingle: () => q, single: () => q,
        ilike: () => { key = table + ':guess'; return q; },
        then: (resolve: any) => resolve(answers[key] ?? { data: null, error: null }),
      };
      return q;
    },
  };
}
`);
  const source = readFileSync(join(REPO_ROOT, 'api/edge/artist-page-static.ts'), 'utf8')
    .replace('https://esm.sh/@supabase/supabase-js@2', join(stubDir, 'supabase.ts'))
    .replace(/"\.\.\/shared\//g, `"${join(REPO_ROOT, 'api/shared')}/`);
  writeFileSync(join(stubDir, 'artist-page-static.ts'), source);

  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'stub';
  ({ setAnswers } = await import(join(stubDir, 'supabase.ts')));
  ({ default: handler } = await import(join(stubDir, 'artist-page-static.ts')));
});

afterAll(() => {
  process.env = originalProcessEnv;
});

const spaShell = () => Promise.resolve(new Response('<div id="root"></div>', {
  status: 200,
  headers: { 'Content-Type': 'text/html' },
}));
const crawl = (path: string) => new Request(`https://unstream.stream${path}`, { headers: { 'User-Agent': GOOGLEBOT } });

describe('artist page for a crawler, when the slug is not a live artist', () => {
  it('redirects a name-guessed slug to the one artist with that name', async () => {
    setAnswers({ 'artists:guess': { data: [{ slug: 'impulsenine', name: 'Impulse Nine' }], error: null } });
    const response = await handler(crawl('/a/impulse-nine'), { next: spaShell });

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/a/impulsenine');
  });

  it('keeps the /artist/ prefix when redirecting', async () => {
    setAnswers({ 'artists:guess': { data: [{ slug: 'impulsenine', name: 'Impulse Nine' }], error: null } });
    const response = await handler(crawl('/artist/impulse-nine'), { next: spaShell });

    expect(response.headers.get('Location')).toBe('/artist/impulsenine');
  });

  it('prefers a recorded alias', async () => {
    setAnswers({ artist_slug_aliases: { data: { artists: { slug: 'trentemoller' } }, error: null } });
    const response = await handler(crawl('/a/trentem-ller'), { next: spaShell });

    expect(response.headers.get('Location')).toBe('/a/trentemoller');
  });

  it('answers a real 404 with noindex when nothing matches, not the shell with 200', async () => {
    setAnswers({});
    const response = await handler(crawl('/a/nobody-at-all'), { next: spaShell });

    expect(response.status).toBe(404);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('<div id="root">');
  });

  it('does not pick between several artists sharing the name', async () => {
    setAnswers({
      'artists:guess': {
        data: [{ slug: 'xparacosm', name: 'Paracosm' }, { slug: 'paracosm-orlando', name: 'Paracosm' }],
        error: null,
      },
    });
    const response = await handler(crawl('/a/paracosm'), { next: spaShell });

    expect(response.status).toBe(404);
  });

  it.each([
    ['the artist read', { artists: { data: null, error: { message: 'connection reset' } } }],
    ['the alias read', { artist_slug_aliases: { data: null, error: { message: 'timeout' } } }],
    ['the name-guess read', { 'artists:guess': { data: null, error: { message: 'timeout' } } }],
  ])('falls through to the plain shell when %s fails: an outage is not a 404', async (_label, answers) => {
    setAnswers(answers);
    const response = await handler(crawl('/a/impulse-nine'), { next: spaShell });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('never queries for a real browser, which gets the SPA', async () => {
    setAnswers({ 'artists:guess': { data: [{ slug: 'impulsenine', name: 'Impulse Nine' }], error: null } });
    const response = await handler(new Request('https://unstream.stream/a/impulse-nine'), { next: spaShell });

    expect(response.status).toBe(200);
  });
});
