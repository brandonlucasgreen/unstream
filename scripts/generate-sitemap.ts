/**
 * Generate sitemap.xml from the artists manifest.
 * Includes all /artist/{slug} URLs plus static pages.
 *
 * Output: public/sitemap.xml
 * Usage: npx tsx scripts/generate-sitemap.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

function main() {
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

  // Artist pages from manifest
  if (existsSync(MANIFEST_PATH)) {
    const manifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

    for (const artist of manifest) {
      const lastmod = artist.lastUpdated.split('T')[0]; // YYYY-MM-DD
      urls.push(`  <url>
    <loc>${escapeXml(`${BASE_URL}/artist/${artist.slug}`)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`);
    }

    console.log(`Added ${manifest.length} artist URLs to sitemap`);
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

main();
