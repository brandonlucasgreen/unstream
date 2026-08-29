/**
 * Generate sitemap.xml from the artists manifest.
 * Includes all /artist/{slug} URLs plus static pages.
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
 * Two more reconciliations were added after the 2026-08-29 audit found six manifest slugs with no
 * artist row:
 *
 *   - **Excluded acts are dropped.** api/lib/excluded-artists.ts removes an artist from the
 *     database, but nothing ever removed them from the manifest, so we kept handing Google
 *     `/artist/absurd` for a page we deleted on ethical grounds.
 *   - **Retired slugs are re-pointed, not dropped.** The accent-folding fix (#410) re-slugged
 *     `trentem-ller` to `trentemoller` and left an `artist_slug_aliases` row behind. Dropping the
 *     manifest slug would be correct-but-useless: the canonical slug isn't in the manifest either,
 *     so five real artists would vanish from the sitemap entirely. Listing the canonical URL is
 *     what actually gets them indexed. The canonicals' `updated_at` comes from a second lookup;
 *     if that one fails, the re-aliased artists stay listed on the manifest's stale date — same
 *     couldn't-ask rule as the main fallback, not silently omitted.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isExcludedArtistSlug } from '../api/lib/excluded-artists';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '..', 'data', 'artists-manifest.json');
const GUIDES_MANIFEST_PATH = join(__dirname, '..', 'data', 'guides', 'guides-manifest.json');
const OUTPUT_PATH = join(__dirname, '..', 'apps', 'web', 'public', 'sitemap.xml');

const BASE_URL = 'https://unstream.stream';

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

/** One client for both lookups below. Null when the credentials aren't set. */
function getSupabase(): SupabaseClient | null {
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
async function fetchArtistUpdatedAt(client: SupabaseClient | null, slugs: string[]): Promise<Map<string, string> | null> {
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

/**
 * `alias -> canonical artists.slug` for the manifest slugs that no longer have a row of their own.
 *
 * An empty map is the safe answer for every failure here: the caller then omits those slugs, which
 * is exactly what it did before this lookup existed. Only a *found* alias changes any output.
 */
async function fetchCanonicalSlugs(client: SupabaseClient | null, aliases: string[]): Promise<Map<string, string>> {
  const canonical = new Map<string, string>();
  if (!client || aliases.length === 0) return canonical;

  for (let i = 0; i < aliases.length; i += 200) {
    const { data, error } = await client
      .from('artist_slug_aliases')
      .select('alias, artists!inner(slug)')
      .in('alias', aliases.slice(i, i + 200));

    if (error) {
      console.warn(`⚠️  Alias lookup failed (${error.message}) — retired slugs will be omitted.`);
      return canonical;
    }
    for (const row of data as unknown as Array<{ alias: string; artists: { slug: string } | null }>) {
      if (row.artists?.slug) canonical.set(row.alias, row.artists.slug);
    }
  }

  return canonical;
}

async function main() {
  // Static pages
  const staticPages = [
    { url: '/', changefreq: 'weekly', priority: '1.0' },
    { url: '/guides', changefreq: 'weekly', priority: '0.8' },
    { url: '/press', changefreq: 'monthly', priority: '0.5' },
    { url: '/contact', changefreq: 'monthly', priority: '0.5' },
    { url: '/privacy-policy', changefreq: 'yearly', priority: '0.3' },
    { url: '/terms', changefreq: 'yearly', priority: '0.3' },
  ];

  let urls = staticPages.map(page => `  <url>
    <loc>${escapeXml(BASE_URL + page.url)}</loc>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`);

  // Artist pages from manifest, reconciled against the database that actually renders them
  if (existsSync(MANIFEST_PATH)) {
    const rawManifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

    // Acts removed on ethical grounds (api/lib/excluded-artists.ts). Their rows are gone, so the
    // reconciliation below would drop them anyway — but only silently, as if they were a data gap.
    // Naming them keeps the removal legible in the build log and keeps that list the one place a
    // decision to exclude an artist has to be recorded.
    const manifest = rawManifest.filter(a => !isExcludedArtistSlug(a.slug));
    const excluded = rawManifest.length - manifest.length;

    const client = getSupabase();
    const updatedAt = await fetchArtistUpdatedAt(client, manifest.map(a => a.slug));

    // Manifest slugs with no row of their own may be retired slugs rather than missing artists.
    // Asked only about the misses, so a healthy manifest costs no extra query at all.
    const misses = updatedAt ? manifest.filter(a => !updatedAt.has(a.slug)).map(a => a.slug) : [];
    const canonicalSlugs = await fetchCanonicalSlugs(client, misses);

    // Dates for the canonical slugs. If this lookup fails we know the canonicals exist (the alias
    // row pointed at a live artist) but not when — the same "couldn't ask" situation the first
    // lookup's null handles, so the same contract applies: list those artists on the manifest's
    // stale date rather than silently dropping the five artists the re-aliasing exists to save.
    let canonicalDatesKnown = true;
    if (canonicalSlugs.size > 0 && updatedAt) {
      const canonicalUpdatedAt = await fetchArtistUpdatedAt(client, [...new Set(canonicalSlugs.values())]);
      if (canonicalUpdatedAt) {
        for (const [slug, at] of canonicalUpdatedAt) updatedAt.set(slug, at);
      } else {
        canonicalDatesKnown = false;
      }
    }

    let omitted = 0;
    let realiased = 0;
    const listed = new Set<string>();

    for (const artist of manifest) {
      let slug = artist.slug;
      let lastmod = artist.lastUpdated;

      // Only skip when we actually know the artist is absent. A null map means the lookup failed,
      // in which case listing everything (the old behaviour) beats shipping a gutted sitemap.
      if (updatedAt) {
        const canonical = updatedAt.has(slug) ? slug : canonicalSlugs.get(slug);
        // A canonical whose date lookup failed is still listed — on the manifest's stale date (see
        // canonicalDatesKnown). Only an unresolvable slug is known absent.
        if (!canonical || (!updatedAt.has(canonical) && canonicalDatesKnown)) {
          omitted++;
          continue;
        }
        if (canonical !== slug) realiased++;
        slug = canonical;
        lastmod = updatedAt.get(canonical) ?? artist.lastUpdated;
      }

      // Two manifest slugs can alias to one artist; the sitemap must not list them twice.
      if (listed.has(slug)) continue;
      listed.add(slug);

      urls.push(`  <url>
    <loc>${escapeXml(`${BASE_URL}/artist/${slug}`)}</loc>
    <lastmod>${lastmod.split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`);
    }

    console.log(`Added ${listed.size} artist URLs to sitemap`);
    if (excluded > 0) {
      console.log(`Skipped ${excluded} excluded artist${excluded === 1 ? '' : 's'} (api/lib/excluded-artists.ts).`);
    }
    if (realiased > 0) {
      console.log(`Listed ${realiased} artist${realiased === 1 ? '' : 's'} at their canonical slug instead of the retired one in the manifest.`);
    }
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
