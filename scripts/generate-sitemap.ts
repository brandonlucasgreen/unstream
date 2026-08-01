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

/**
 * `updated_at` per published slug, or null if Supabase is unreachable/unconfigured.
 *
 * Null is the "couldn't ask" signal and is handled differently from an artist simply being absent
 * — the distinction that stops a credentials problem from silently emptying the sitemap.
 */
async function fetchArtistUpdatedAt(slugs: string[]): Promise<Map<string, string> | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('⚠️  SUPABASE_URL/SUPABASE_SERVICE_KEY not set — falling back to manifest dates.');
    return null;
  }

  const client = createClient(url, key);
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
