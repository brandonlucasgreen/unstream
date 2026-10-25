// Audit 2026-10-25 #7: when the database failed, the release page fell through to the SPA, whose
// catch-all is NotFoundPage — an outage read "this page doesn't exist". A query error was worse
// still: it came back as `error`, unchecked, so a failed release read redirected to the artist page
// as though the release had been removed. Both now answer a no-store 503.
//
// Loads the real edge function the way scripts/preview-release-page.ts does: its Deno-only URL
// imports rewritten to local stubs in a temp directory.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');

type Handler = (request: Request, context: { next: () => Promise<Response> }) => Promise<Response>;
let handler: Handler;
let setAnswers: (answers: Record<string, { data: unknown; error: unknown }>) => void;
const originalProcessEnv = { ...process.env };

beforeAll(async () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'unstream-release-503-'));
  // Each table answers whatever the test set, as `{ data, error }`, the way supabase-js resolves.
  writeFileSync(join(stubDir, 'supabase.ts'), `
let answers: Record<string, { data: unknown; error: unknown }> = {};
export function setAnswers(a: Record<string, { data: unknown; error: unknown }>) { answers = a; }
export function createClient() {
  let table = '';
  const q: any = {
    select: () => q, eq: () => q, abortSignal: () => q, maybeSingle: () => q,
    then: (resolve: any) => resolve(answers[table] ?? { data: null, error: null }),
  };
  return { from(t: string) { table = t; return q; } };
}
`);
  const source = readFileSync(join(REPO_ROOT, 'api/edge/release-page.ts'), 'utf8')
    .replace('https://esm.sh/@supabase/supabase-js@2', join(stubDir, 'supabase.ts'))
    .replace(/"\.\.\/shared\//g, `"${join(REPO_ROOT, 'api/shared')}/`);
  writeFileSync(join(stubDir, 'release-page.ts'), source);

  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'stub';
  ({ setAnswers } = await import(join(stubDir, 'supabase.ts')));
  ({ default: handler } = await import(join(stubDir, 'release-page.ts')));
});

afterAll(() => {
  process.env = originalProcessEnv;
});

const notFoundShell = () => Promise.resolve(new Response('<div id="root"></div>', { status: 200 }));
const request = () => new Request('https://unstream.stream/a/kid-lightbulbs/infinite-normal');

describe('release page when the database fails', () => {
  it('answers 503, uncached, when the artist read errors', async () => {
    setAnswers({ artists: { data: null, error: { message: 'connection reset' } } });
    const response = await handler(request(), { next: notFoundShell });

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(await response.text()).toContain('temporarily unavailable');
  });

  it('answers 503 rather than redirecting when the release read errors', async () => {
    setAnswers({
      artists: { data: { id: 'a1', name: 'Kid Lightbulbs', image_url: null }, error: null },
      releases: { data: null, error: { message: 'statement timeout' } },
    });
    const response = await handler(request(), { next: notFoundShell });

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('href="/a/kid-lightbulbs"');
  });

  it('still bounces a release that genuinely is not there to the artist page', async () => {
    setAnswers({
      artists: { data: { id: 'a1', name: 'Kid Lightbulbs', image_url: null }, error: null },
      releases: { data: null, error: null },
    });
    const response = await handler(request(), { next: notFoundShell });

    expect(response.status).toBe(302);
  });

  it('still hands a genuinely unknown artist to the next renderer', async () => {
    setAnswers({});
    const response = await handler(request(), { next: notFoundShell });

    expect(response.status).toBe(200);
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
  });
});
