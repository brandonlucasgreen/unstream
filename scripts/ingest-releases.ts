/**
 * Try release ingest against a real Bandcamp page, locally, without writing anything.
 *
 * Usage:
 *   npx tsx scripts/ingest-releases.ts <bandcamp-url-or-slug>
 *   npx tsx scripts/ingest-releases.ts sufjanstevens
 *   npx tsx scripts/ingest-releases.ts https://music.sufjan.com/music
 *   npx tsx scripts/ingest-releases.ts sufjanstevens --json
 *   npx tsx scripts/ingest-releases.ts sufjanstevens --detail      (newest 3 release pages)
 *   npx tsx scripts/ingest-releases.ts sufjanstevens --detail=10
 *
 * Exercises the whole ingest path that matters — fetch (with the same SSRF-safe fetcher
 * production uses), parse, and map to release rows — and prints what *would* be written.
 *
 * `--detail` additionally reads individual release pages, which is where dates, formats and
 * prices live. It costs one request per release, so it's opt-in and capped low here; in
 * production the same pass is metered by budgets in catalog-artist-background.ts.
 *
 * DRY RUN ONLY, DELIBERATELY. There is no --write flag, because .env points at the
 * production Supabase: a local write path would mean a laptop writing real `releases` rows,
 * which is the exact thing the CONTEXT === 'production' gate exists to prevent. Everything
 * interesting is upstream of the database anyway — the parse and the mapping are where the
 * decisions live, and `persistReleases` is covered by unit tests and by the migration being
 * validated against a real Postgres. To test the write path, point SUPABASE_URL at a branch
 * database on purpose.
 *
 * One Bandcamp request per run (plus redirects). Be a good neighbour and don't loop it.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const { safeFetch } = await import('../api/functions/safe-fetch.js');
const { isUrlHostnameAllowed } = await import('../api/functions/middleware.js');
const { ingestBandcampGrid, ingestBandcampDetail, bandcampMusicUrl } =
  await import('../api/functions/release-ingest.js');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const target = args.find(a => !a.startsWith('--'));

/** How many release pages to read. 0 = none, which is the default: they cost a request each. */
const detailArg = args.find(a => a === '--detail' || a.startsWith('--detail='));
const detailCount = !detailArg ? 0 : Number(detailArg.split('=')[1] ?? 3) || 3;

if (!target) {
  console.error('Usage: npx tsx scripts/ingest-releases.ts <bandcamp-url-or-slug> [--json]');
  process.exit(1);
}

// A bare word is treated as a Bandcamp subdomain, which is how most artists are stored.
const artistUrl = target.includes('://') ? target : `https://${target}.bandcamp.com`;

const musicUrl = bandcampMusicUrl(artistUrl);
if (!musicUrl) {
  console.error(`Could not derive a /music URL from ${artistUrl}`);
  process.exit(1);
}

// Same two checks production applies, in the same order, so this exercises the real gates
// rather than a convenient shortcut around them.
if (!isUrlHostnameAllowed(musicUrl)) {
  console.error(`Refused: ${musicUrl} is not on the outbound allowlist.`);
  console.error('A custom domain will fail here, exactly as it would in production — ingest');
  console.error('resolves those by following a redirect from the *.bandcamp.com URL.');
  process.exit(1);
}

if (!asJson) console.log(`\nFetching ${musicUrl} …`);

const response = await safeFetch(musicUrl, 15_000);
if (!response) {
  console.error('Fetch refused (unsafe target or too many redirects).');
  process.exit(1);
}
if (!response.ok) {
  console.error(`Bandcamp responded ${response.status}.`);
  process.exit(1);
}

const landedUrl = response.url || musicUrl;
const html = await response.text();
const outcome = ingestBandcampGrid(html, landedUrl);

if (!outcome.ok) {
  // The distinction matters: 'bot_challenge' means Bandcamp declined to answer (production
  // treats it as a failure and backs off), while 'no_releases' is a real empty catalog.
  console.error(`\nNothing ingested — reason: ${outcome.reason}`);
  if (outcome.reason === 'bot_challenge') {
    console.error('Fastly served a bot challenge with HTTP 200. Not an empty artist.');
  }
  process.exit(2);
}

/**
 * Read individual release pages for date, formats and prices — the same pass production runs,
 * with the same fetcher and the same mapping, just capped at a handful of pages.
 */
async function readDetails(urls: string[]) {
  const results: Array<{ url: string; detail: unknown }> = [];
  for (const [index, url] of urls.entries()) {
    if (index > 0) await new Promise(r => setTimeout(r, 1_000)); // be a good neighbour
    const res = await safeFetch(url, 15_000);
    if (!res?.ok) {
      results.push({ url, detail: { error: res ? `HTTP ${res.status}` : 'fetch refused' } });
      continue;
    }
    const detailOutcome = ingestBandcampDetail(await res.text());
    results.push({ url, detail: detailOutcome.ok ? detailOutcome.detail : { error: detailOutcome.reason } });
  }
  return results;
}

const detailUrls = outcome.releases.slice(0, detailCount).map(r => r.source.url);

if (asJson) {
  const details = detailUrls.length > 0 ? await readDetails(detailUrls) : undefined;
  console.log(JSON.stringify({ landedUrl, releases: outcome.releases, details }, null, 2));
  process.exit(0);
}

if (landedUrl !== musicUrl) console.log(`Redirected to ${landedUrl}`);
console.log(`\nWould write ${outcome.releases.length} release(s). Nothing was saved.\n`);

// Always leave a trailing space, so a value that exactly fills the column doesn't run into
// the next one.
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 2) + '… ' : s.padEnd(n));
console.log(pad('TYPE', 12) + pad('TITLE', 42) + pad('SLUG', 34) + 'ART');
console.log('-'.repeat(92));
for (const r of outcome.releases) {
  console.log(pad(r.releaseType, 12) + pad(r.title, 42) + pad(r.slug, 34) + (r.artworkUrl ? 'yes' : 'NO'));
}

// Surfaced because they're the things most likely to be quietly wrong, and a count is easier
// to sanity-check at a glance than reading every row.
const missingArt = outcome.releases.filter(r => !r.artworkUrl).length;
const missingId = outcome.releases.filter(r => !r.source.externalId).length;
console.log(`\nsummary: ${outcome.releases.length} releases, ${missingArt} without artwork, ${missingId} without a stable id`);

if (detailUrls.length === 0) {
  console.log('note: release dates are always null above — they live on individual release pages,');
  console.log('      at one extra request each. Pass --detail to read the newest few.\n');
} else {
  console.log(`\nReading ${detailUrls.length} release page(s) for dates, formats and prices …\n`);
  for (const { url, detail } of await readDetails(detailUrls)) {
    console.log(url.replace(/^https?:\/\//, ''));
    const d = detail as { releaseDate?: string | null; datePrecision?: string; status?: string;
      offers?: Array<{ format: string; price: number | null; currency: string | null; availability: string }>;
      error?: string };
    if (d.error) {
      console.log(`  could not read: ${d.error}\n`);
      continue;
    }
    console.log(`  date: ${d.releaseDate ?? 'none'} (${d.datePrecision}) · status: ${d.status}`);
    if (!d.offers?.length) {
      // Expected on standalone tracks: their page has a date but no offer in its JSON-LD.
      console.log('  offers: none listed\n');
      continue;
    }
    for (const o of d.offers) {
      const price = o.price === null ? 'no price' : `${o.price} ${o.currency ?? ''}`.trim();
      console.log(`  ${o.format.padEnd(9)} ${price.padEnd(12)} ${o.availability}`);
    }
    console.log('');
  }
}
