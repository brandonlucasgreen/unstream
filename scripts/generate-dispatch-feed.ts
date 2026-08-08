/**
 * Generate dispatch.xml (RSS 2.0 feed) from data/dispatch/*.md
 *
 * Each dispatch markdown file has YAML frontmatter:
 *   ---
 *   title: "Week of April 17, 2026"
 *   week: 2026-W16
 *   published: 2026-04-17
 *   summary: "One-line teaser"
 *   draft: true          (optional — excluded from feed)
 *   ---
 *
 * README.md and PROMPT.md in the dispatch directory are ignored.
 *
 * The Dispatch itself moved to Discord in April 2026 and nothing new is written here — this
 * keeps the historical feed rendering. See data/dispatch/README.md.
 *
 * Output: apps/web/public/dispatch.xml
 * Usage: npx tsx scripts/generate-dispatch-feed.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

import { SITE_URL, toRfc822, parseFrontmatter, buildRssFeed, type RssItem } from './rss';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCH_DIR = join(__dirname, '..', 'data', 'dispatch');
const OUTPUT_PATH = join(__dirname, '..', 'apps', 'web', 'public', 'dispatch.xml');

const FEED_URL = `${SITE_URL}/dispatch.xml`;
const FEED_TITLE = 'The Unstream Dispatch';
const FEED_DESCRIPTION = 'Weekly music industry intelligence — platform news, streaming economics, and what it means for independent artists. Written by Unstream.';

const IGNORED_FILES = new Set(['README.md', 'PROMPT.md']);

function main() {
  const files = readdirSync(DISPATCH_DIR).filter(
    (f) => f.endsWith('.md') && !IGNORED_FILES.has(f)
  );

  const items: RssItem[] = [];

  for (const file of files) {
    const content = readFileSync(join(DISPATCH_DIR, file), 'utf-8');
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

    const missing = ['title', 'week', 'published', 'summary'].filter((k) => !fields[k]);
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

    items.push({
      title: fields.title,
      link: `${SITE_URL}/dispatch/${slug}`,
      guid: `unstream-dispatch-${slug}`,
      pubDate: fields.published,
      description: fields.summary,
      contentHtml: marked.parse(body, { async: false }) as string,
    });
  }

  // Sort newest first
  items.sort((a, b) => b.pubDate.localeCompare(a.pubDate));

  const feed = buildRssFeed(
    { title: FEED_TITLE, description: FEED_DESCRIPTION, link: SITE_URL, feedUrl: FEED_URL },
    items,
    new Date(),
  );

  writeFileSync(OUTPUT_PATH, feed);
  console.log(`Wrote ${items.length} dispatch${items.length === 1 ? '' : 'es'} to ${OUTPUT_PATH}`);
}

main();
