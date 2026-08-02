/**
 * Generate sitemap.xml from the artists manifest.
 * Includes all /artist/{slug} URLs, every catalogued /a/{artist}/{release} URL, plus static pages.
 *
 * Output: public/sitemap.xml
 * Usage: npx tsx scripts/generate-sitemap.ts
 *
 * Artist entries are reconciled against Supabase, because the manifest alone describes the
 * *static* files under data/artists/ — which nothing has rendered since #274 moved the page onto
 * /api/artist-page. Two things went wrong as a result, both fixed here:
 *
 *   - `lastmod` was every artist's `lastUpdated` from the manifest, i.e. the day the static file
 *     was generated (2026-03-24 for all 791). It said nothing about the page a visitor gets, and
 *     told Google nothing had changed on the day 736 of those pages came back to life.
 *   - Every manifest slug was listed whether or not it resolved, so the sitemap advertised 736
 *     404s for six weeks (see PR #384).
 *
 * So: `lastmod` comes from `artists.updated_at`, and a slug with no artist row is left out rather
 * than advertised. If Supabase can't be reached the build must not fail or silently ship an empty
 * sitemap, so it falls back to the old manifest-only behaviour and says so loudly.
 *
 * Release pages have no manifest at all — they exist only where demand-driven cataloging has run
 * — so they come straight from the database, on the same rule: list a URL only if it renders.
 * When Supabase is unreachable, none are listed rather than guessed at, and the build says so.
 *
 * The whole file is a build-time snapshot either way: an artist catalogued after a deploy shows
 * up in the sitemap at the next one. Their release pages are linked from the artist page in the
 * meantime, so they are reachable, just not advertised.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '..', 'data', 'artists-manifest.json');
const GUIDES_MANIFEST_PATH = join(__dirname, '..', 'data', 'guides', 'guides-manifest.json');
const OUTPUT_PATH = join(__dirname, '..', 'apps', 'web', 'public', 'sitemap.xml');

const BASE_URL = 'https://unstream.stream';

/**
 * Sitemaps are capped at 50,000 URLs by the protocol. Warn well before that so the split into a
 * sitemap index is a planned change rather than something discovered from Search Console after
 * a batch catalog run quietly pushed the file over the line.
 */
const URL_COUNT_WARN_AT = 45_000;

/** Rows to ask for per request. Supabase won't return more than 1,000; it may return fewer. */
const RELEASE_PAGE_SIZE = 1_000;

interface ManifestEntry {
  name: string;
  slug: string;
  imageUrl: string | null;
  platformCount: number;
  lastUpdated: string;
}

interface GuideEntry {
  slug: string;
  title: string;
  description: string;
  pillar: string;
  published: string;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The service-role client, or null when it isn't configured. Both lookups below share it. */
function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * `updated_at` per published slug, or null if Supabase is unreachable/unconfigured.
 *
 * Null is the "couldn't ask" signal and is handled differently from an artist simply being absent
 * — the distinction that stops a credentials problem from silently emptying the sitemap.
 */
async function fetchArtistUpdatedAt(slugs: string[]): Promise<Map<string, string> | null> {
  const client = getClient();
  if (!client) {
    console.warn('⚠️  SUPABASE_URL/SUPABASE_SERVICE_KEY not set — falling back to manifest dates.');
    return null;
  }

  const updatedAt = new Map<string, string>();

  for (let i = 0; i < slugs.length; i += 200) {
    const { data, error } = await client
      .from('artists')
      .select('slug, updated_at')
      .in('slug', slugs.slice(i, i + 200));

    if (error) {
      console.warn(`⚠️  Supabase lookup failed (${error.message}) — falling back to manifest dates.`);
      return null;
    }
    for (const row of data) {
      if (row.updated_at) updatedAt.set(row.slug, row.updated_at);
    }
  }

  return updatedAt;
}

interface ReleaseEntry {
  artistSlug: string;
  releaseSlug: string;
  updatedAt: string;
}

/**
 * Every release page that renders, or null if Supabase is unreachable/unconfigured.
 *
 * Same "couldn't ask" convention as `fetchArtistUpdatedAt`, and same reason: an empty array would
 * read as "this site has no release pages", which is a claim, not an absence of one.
 *
 * `is_hidden` + `needs_review` is the same pair the feeds exclude on (`getFeedReleasesForUser` in
 * api/functions/db.ts), for the same two reasons: a hidden release was suppressed by an artist
 * and must stay invisible, and a `needs_review` tier-3 fuzzy flag means we aren't sure the
 * release is distinct. `release-page.ts` itself only filters the first, which is right for
 * someone following a link but not for what we volunteer to a crawler — listing both sides of a
 * suspected duplicate hands Google two URLs for one record.
 *
 * The join is inner, so a release whose artist row has gone is dropped rather than emitted as
 * `/a/undefined/…`.
 */
async function fetchReleaseEntries(): Promise<ReleaseEntry[] | null> {
  const client = getClient();
  if (!client) {
    console.warn('⚠️  SUPABASE_URL/SUPABASE_SERVICE_KEY not set — no release URLs in the sitemap.');
    return null;
  }

  const entries: ReleaseEntry[] = [];

  // Ordered by a unique column so the pages can't overlap or skip: without an order Postgres
  // makes no promise about row order between requests, and the silent result is a sitemap
  // missing an arbitrary slice of releases — which looks exactly like a sitemap that is complete.
  //
  // The cursor advances by however many rows *came back*, not by the page size we asked for, and
  // stops only on an empty page. PostgREST applies its own `max-rows` ceiling on top of our
  // range, so a server configured below RELEASE_PAGE_SIZE would make every page look short —
  // and "short page means last page" would then end the walk after one request and call it done.
  for (let from = 0; ; ) {
    const { data, error } = await client
      .from('releases')
      .select('slug, updated_at, artists!inner ( slug )')
      .eq('is_hidden', false)
      .eq('needs_review', false)
      .order('id', { ascending: true })
      .range(from, from + RELEASE_PAGE_SIZE - 1);

    if (error) {
      console.warn(`⚠️  Release lookup failed (${error.message}) — no release URLs in the sitemap.`);
      return null;
    }
    if (data.length === 0) break;

    for (const row of data as unknown as { slug: string; updated_at: string; artists: { slug: string } }[]) {
      if (!row.artists?.slug || !row.slug) continue;
      entries.push({ artistSlug: row.artists.slug, releaseSlug: row.slug, updatedAt: row.updated_at });
    }

    from += data.length;
  }

  return entries;
}

async function main() {
  // Static pages
  const staticPages = [
    { url: '/', changefreq: 'weekly', priority: '1.0' },
    { url: '/guides', changefreq: 'weekly', priority: '0.8' },
    { url: '/privacy-policy', changefreq: 'yearly', priority: '0.3' },
  ];

  let urls = staticPages.map(page => `  <url>
    <loc>${escapeXml(BASE_URL + page.url)}</loc>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`);

  // Artist pages from manifest, reconciled against the database that actually renders them
  if (existsSync(MANIFEST_PATH)) {
    const manifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    const updatedAt = await fetchArtistUpdatedAt(manifest.map(a => a.slug));

    let omitted = 0;

    for (const artist of manifest) {
      // Only skip when we actually know the artist is absent. A null map means the lookup failed,
      // in which case listing everything (the old behaviour) beats shipping a gutted sitemap.
      if (updatedAt && !updatedAt.has(artist.slug)) {
        omitted++;
        continue;
      }

      const lastmod = (updatedAt?.get(artist.slug) ?? artist.lastUpdated).split('T')[0]; // YYYY-MM-DD
      urls.push(`  <url>
    <loc>${escapeXml(`${BASE_URL}/artist/${artist.slug}`)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`);
    }

    console.log(`Added ${manifest.length - omitted} artist URLs to sitemap`);
    if (omitted > 0) {
      console.log(`Omitted ${omitted} manifest slug${omitted === 1 ? '' : 's'} with no artist row — ${omitted === 1 ? 'that URL 404s' : 'those URLs 404'}.`);
      console.log('  Run `npm run backfill:artist-rows` to give them pages instead of dropping them.');
    }
  } else {
    console.log('No artists manifest found, generating sitemap with static pages only');
  }

  // Guide pages from manifest
  if (existsSync(GUIDES_MANIFEST_PATH)) {
    const guides: GuideEntry[] = JSON.parse(readFileSync(GUIDES_MANIFEST_PATH, 'utf-8'));

    for (const guide of guides) {
      urls.push(`  <url>
    <loc>${escapeXml(`${BASE_URL}/guides/${guide.slug}`)}</loc>
    <lastmod>${guide.published}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`);
    }

    console.log(`Added ${guides.length} guide URLs to sitemap`);
  }

  // Release pages. Below artist pages in priority: the artist page is the hub a fan lands on and
  // the release page is one record within it. `monthly` matches the 30-day price refresh in
  // catalog-artist-background.ts — a release page's content is its formats and prices, and that
  // is how often we re-read them.
  const releases = await fetchReleaseEntries();

  if (releases) {
    for (const release of releases) {
      const loc = `${BASE_URL}/a/${encodeURIComponent(release.artistSlug)}/${encodeURIComponent(release.releaseSlug)}`;
      urls.push(`  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${release.updatedAt.split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`);
    }

    console.log(`Added ${releases.length} release URLs to sitemap`);
    if (releases.length === 0) {
      console.log('  No releases are catalogued yet — cataloging is demand-driven (see CLAUDE.md).');
    }
  }

  // Said out loud rather than silently truncated: the 50,000 ceiling is a protocol limit, and a
  // sitemap that quietly drops URLs past it reads as a complete one.
  if (urls.length >= URL_COUNT_WARN_AT) {
    console.warn(`⚠️  ${urls.length} URLs — the sitemap protocol caps a single file at 50,000.`);
    console.warn('    Split into a sitemap index before the next batch of releases lands.');
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

  writeFileSync(OUTPUT_PATH, sitemap);
  console.log(`Wrote sitemap to ${OUTPUT_PATH} (${urls.length} URLs)`);
}

// Fail the build rather than deploy whatever sitemap happened to be on disk. Supabase being
// unreachable is already handled inside as a fallback, so reaching here means a real fault.
main().catch(error => {
  console.error('Sitemap generation failed:', error);
  process.exit(1);
});
