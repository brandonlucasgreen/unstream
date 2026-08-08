/**
 * Generate guides.xml (RSS 2.0 feed) from data/guides/*.md
 *
 * Same frontmatter the guides manifest reads (title, description, pillar, published, draft) —
 * see scripts/generate-guides-manifest.ts. Drafts are excluded from both.
 *
 * Unlike the changelog feed, this one carries the **full rendered post** in content:encoded.
 * Guides are the long-form writing, and a feed that only carries the one-line description
 * gives a reader nothing to read and gives Buttondown nothing to send.
 *
 * Output: apps/web/public/guides.xml
 * Usage: npx tsx scripts/generate-guides-feed.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

import { SITE_URL, escapeXml, toRfc822, parseFrontmatter, buildRssFeed, type RssItem } from './rss';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, '..', 'data', 'guides');
const OUTPUT_PATH = join(__dirname, '..', 'apps', 'web', 'public', 'guides.xml');

const PAGE_URL = `${SITE_URL}/guides`;
const FEED_URL = `${SITE_URL}/guides.xml`;
const FEED_TITLE = 'Unstream Guides';
const FEED_DESCRIPTION =
  "How streaming payouts work, platforms worth knowing about, and ways to put more money in artists' pockets.";

function main() {
  const files = readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.md'));
  const items: RssItem[] = [];

  for (const file of files) {
    const content = readFileSync(join(GUIDES_DIR, file), 'utf-8');
    const parsed = parseFrontmatter(content);

    if (!parsed) {
      console.warn(`Skipping ${file}: no frontmatter found`);
      continue;
    }

    const { fields, body } = parsed;

    if (fields.draft === 'true') {
      console.log(`Skipping ${file}: draft`);
      continue;
    }

    const missing = ['title', 'description', 'published'].filter((k) => !fields[k]);
    if (missing.length > 0) {
      console.warn(`Skipping ${file}: missing frontmatter fields: ${missing.join(', ')}`);
      continue;
    }

    try {
      toRfc822(fields.published);
    } catch (e) {
      console.warn(`Skipping ${file}: ${(e as Error).message}`);
      continue;
    }

    const slug = basename(file, '.md');
    const link = `${PAGE_URL}/${slug}`;
    const html = marked.parse(body, { async: false }) as string;

    items.push({
      title: fields.title,
      link,
      guid: `unstream-guide-${slug}`,
      pubDate: fields.published,
      description: fields.description,
      contentHtml: `${html}\n<p><a href="${escapeXml(link)}">Read this on Unstream</a></p>`,
    });
  }

  // Newest first
  items.sort((a, b) => b.pubDate.localeCompare(a.pubDate));

  const feed = buildRssFeed(
    { title: FEED_TITLE, description: FEED_DESCRIPTION, link: PAGE_URL, feedUrl: FEED_URL },
    items,
    new Date(),
  );

  writeFileSync(OUTPUT_PATH, feed);
  console.log(`Wrote ${items.length} guide${items.length === 1 ? '' : 's'} to ${OUTPUT_PATH}`);
}

main();
