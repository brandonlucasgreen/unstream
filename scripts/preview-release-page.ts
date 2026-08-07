/**
 * See the release page locally, with real data, without a database.
 *
 * Usage:
 *   npm run preview:release -- explosionsinthesky
 *   npm run preview:release -- sufjanstevens --port=8123
 *
 * Then open the printed URL. The index lists the artist's whole discography; clicking a
 * release fetches that release's page from Bandcamp and renders it through the **real**
 * `api/edge/release-page.ts` — the same template, the same formatting, the same payout maths
 * that production will run.
 *
 * WHY THIS EXISTS
 *
 * `npm run dev` cannot show you this page. The Vite dev server doesn't run edge functions at
 * all (see "Local dev API vs production API" in CLAUDE.md), and `netlify dev` — which does —
 * reads the production Supabase, where the `releases` table is empty until demand-driven
 * cataloging has run for an artist. So the one thing you'd want to look at is the one thing
 * neither of those can show you.
 *
 * WHAT IS AND ISN'T REAL
 *
 * Real: the fetch (the production SSRF-safe fetcher), the grid parse, the release-page parse,
 * the type/date/offer mapping, and the entire rendered page including payout estimates and
 * Bandcamp Friday handling.
 *
 * Faked: only the database reads, including one alias row so the retired-slug redirect can be
 * seen (there is a link for it on the index page). Nothing is written anywhere — there is no
 * database connection at all, which is the point.
 *
 * One Bandcamp request for the grid, then one per release page you open. Be a good neighbour.
 */

import { config } from 'dotenv';
import { createServer } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..');

const { safeFetch } = await import('../api/functions/safe-fetch.js');
const { isUrlHostnameAllowed } = await import('../api/functions/middleware.js');
const { ingestBandcampGrid, ingestBandcampDetail, bandcampMusicUrl } =
  await import('../api/functions/release-ingest.js');

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const port = Number(args.find(a => a.startsWith('--port='))?.split('=')[1] ?? 8788);

if (!target) {
  console.error('Usage: npm run preview:release -- <bandcamp-url-or-slug> [--port=8788]');
  process.exit(1);
}

const artistUrl = target.includes('://') ? target : `https://${target}.bandcamp.com`;
const musicUrl = bandcampMusicUrl(artistUrl);
if (!musicUrl || !isUrlHostnameAllowed(musicUrl)) {
  console.error(`Refused: ${artistUrl} is not a fetchable Bandcamp URL.`);
  process.exit(1);
}

console.log(`\nFetching ${musicUrl} …`);
const gridResponse = await safeFetch(musicUrl, 15_000);
if (!gridResponse?.ok) {
  console.error(`Bandcamp responded ${gridResponse ? gridResponse.status : 'not at all'}.`);
  process.exit(1);
}

const landedUrl = gridResponse.url || musicUrl;
const outcome = ingestBandcampGrid(await gridResponse.text(), landedUrl);
if (!outcome.ok) {
  console.error(`\nNothing to preview — reason: ${outcome.reason}`);
  process.exit(2);
}

const releases = outcome.releases;
const artistSlug = target.includes('://') ? new URL(landedUrl).hostname.split('.')[0] : target;
let artistName = artistSlug;

// ---------------------------------------------------------------------------
// Load the real edge function, with its three Deno-only imports redirected
// ---------------------------------------------------------------------------

const stubDir = mkdtempSync(join(tmpdir(), 'unstream-release-preview-'));

writeFileSync(join(stubDir, 'edge.ts'), `export type Context = { next: () => Response };\n`);

// The three database reads the edge function makes, answered from memory. `_table` and the
// `.eq()` filters are recorded by the builder and read by then(), which works because the
// function awaits each query before starting the next one.
//
// The filters matter: the artists read has to *miss* for a retired slug, or the alias branch
// this harness exists to show can never run.
writeFileSync(join(stubDir, 'supabase.ts'), `
export let artist: any = null;
export let release: any = null;
export let alias: any = null;
export function setRows(a: any, r: any, al: any = null) { artist = a; release = r; alias = al; }
export function createClient() {
  const q: any = {
    _table: '',
    _filters: {} as Record<string, unknown>,
    select: () => q,
    eq: (column: string, value: unknown) => { q._filters[column] = value; return q; },
    abortSignal: () => q,
    maybeSingle: () => q,
    then: (resolve: any) => resolve({ data: rowFor() }),
  };
  function rowFor() {
    if (q._table === 'artists') return q._filters.slug === artist?.slug ? artist : null;
    if (q._table === 'artist_slug_aliases') {
      return q._filters.alias === alias?.alias ? { artists: { slug: artist?.slug } } : null;
    }
    return release;
  }
  return { from(table: string) { q._table = table; q._filters = {}; return q; } };
}
`);

const source = (await import('fs')).readFileSync(join(REPO_ROOT, 'api/edge/release-page.ts'), 'utf8')
  .replace('https://edge.netlify.com', join(stubDir, 'edge.ts'))
  .replace('https://esm.sh/@supabase/supabase-js@2', join(stubDir, 'supabase.ts'))
  // Relative shared imports would break from a temp directory.
  .replace(/"\.\.\/shared\//g, `"${join(REPO_ROOT, 'api/shared')}/`);

const modulePath = join(stubDir, 'release-page.ts');
writeFileSync(modulePath, source);

// The edge function reads env through Deno.env; it only checks that the two Supabase values
// are present, since the client itself is stubbed above.
(globalThis as Record<string, unknown>).Deno = {
  env: { get: (key: string) => (key.startsWith('SUPABASE') ? 'preview' : undefined) },
};

const { setRows } = await import(modulePath.replace('release-page.ts', 'supabase.ts'));
const { default: renderReleasePage } = await import(modulePath);

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

/** Release pages already fetched, so clicking around doesn't re-request Bandcamp. */
const detailCache = new Map<string, { detail: unknown; checkedAt: string }>();

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A stand-in for a row in `artist_slug_aliases`. Requests under it miss the artists table and
 * take the alias branch in the edge function, which 301s to the canonical URL.
 */
const RETIRED_SLUG = `${artistSlug}-retired`;

function indexPage(): string {
  const rows = releases.map(r =>
    `<li style="margin:6px 0"><a href="/a/${artistSlug}/${r.slug}">${escape(r.title)}</a>
     <span style="color:#888;font-size:13px"> — ${r.releaseType}${detailCache.has(r.slug) ? ' · fetched' : ''}</span></li>`
  ).join('');
  const first = releases[0];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Release page preview</title>
    <style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 24px;line-height:1.5}
    a{color:#e55a2b}code{background:#eee;padding:1px 5px;border-radius:4px}</style></head><body>
    <h1>${escape(artistName)}</h1>
    <p style="color:#666">${releases.length} releases from <code>${escape(landedUrl)}</code>.
    Opening one fetches its release page from Bandcamp (one request) and renders it through the
    real edge function. Nothing is written anywhere.</p>
    <ul style="padding-left:18px">${rows}</ul>
    ${first ? `<p style="color:#666">Retired slug:
      <a href="/a/${RETIRED_SLUG}/${first.slug}"><code>/a/${RETIRED_SLUG}/${escape(first.slug)}</code></a>
      — misses the artists table, resolves through <code>artist_slug_aliases</code>, and 301s to
      the canonical URL.</p>` : ''}
    </body></html>`;
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexPage());
    return;
  }

  const match = path.match(/^\/a\/([^/]+)\/([^/]+)\/?$/);
  const requestedArtist = match?.[1];
  const release = match ? releases.find(r => r.slug === match[2]) : undefined;
  if (!release) {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // A retired slug redirects before the release is ever read, so there is nothing to fetch for it.
  if (requestedArtist === artistSlug && !detailCache.has(release.slug)) {
    console.log(`  fetching ${release.source.url}`);
    const detailResponse = await safeFetch(release.source.url, 15_000);
    const outcome = detailResponse?.ok
      ? ingestBandcampDetail(await detailResponse.text())
      : ({ ok: false, reason: 'fetch failed' } as const);
    if (outcome.ok) {
      detailCache.set(release.slug, { detail: outcome.detail, checkedAt: new Date().toISOString() });
    } else {
      // Left uncached deliberately: this previews the "still gathering" state, which is what
      // every release in the real catalog currently shows.
      console.warn(`  could not read detail (${'reason' in outcome ? outcome.reason : '?'})`);
    }
  }

  const cached = detailCache.get(release.slug);
  const detail = cached?.detail as
    | { releaseDate: string | null; datePrecision: string; status: string; offers: Array<Record<string, unknown>> }
    | undefined;

  setRows(
    { id: 'preview-artist', slug: artistSlug, name: artistName, image_url: null },
    {
      title: release.title,
      release_type: release.releaseType,
      release_date: detail?.releaseDate ?? null,
      date_precision: detail?.datePrecision ?? 'unknown',
      status: detail?.status ?? 'released',
      artwork_url: release.artworkUrl,
      release_sources: [
        {
          platform: 'bandcamp',
          url: release.source.url,
          detail_checked_at: cached?.checkedAt ?? null,
          release_offers: (detail?.offers ?? []).map(offer => ({
            ...offer,
            captured_at: cached?.checkedAt ?? new Date().toISOString(),
          })),
        },
      ],
    },
    { alias: RETIRED_SLUG }
  );

  const response = await renderReleasePage(
    new Request(`https://unstream.stream${path}`),
    { next: () => new Response('fell through to the SPA', { status: 404 }) }
  );

  // The function's own headers, not a hand-set Content-Type: a redirect carries its answer in
  // Location and Cache-Control, and dropping those would make the redirect branches unviewable.
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  res.end(await response.text());
});

// The artist's real name comes from the first release page we read; until then the slug does.
const first = releases[0];
if (first) {
  const nameResponse = await safeFetch(first.source.url, 15_000);
  if (nameResponse?.ok) {
    const html = await nameResponse.text();
    const outcome = ingestBandcampDetail(html);
    if (outcome.ok) {
      detailCache.set(first.slug, { detail: outcome.detail, checkedAt: new Date().toISOString() });
    }
    artistName = html.match(/"byArtist":\{[^}]*"name":"([^"]+)"/)?.[1] ?? artistSlug;
  }
}

server.listen(port, () => {
  console.log(`\n${releases.length} releases found. Preview at http://localhost:${port}\n`);
  console.log('Nothing is written to any database. Ctrl-C to stop.\n');
});
