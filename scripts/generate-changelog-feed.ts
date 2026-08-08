/**
 * Generate changelog.xml (RSS 2.0 feed) from data/shipped-features.json
 *
 * One item per shipped feature, newest first — the same list the /changelog page renders.
 * The feed exists so people can follow releases in a reader, and so Buttondown can pull new
 * entries in as newsletter drafts instead of them being retyped by hand.
 *
 * Output: apps/web/public/changelog.xml
 * Usage: npx tsx scripts/generate-changelog-feed.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { SITE_URL, escapeXml, toRfc822, buildRssFeed, type RssItem } from './rss';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'data', 'shipped-features.json');
const OUTPUT_PATH = join(__dirname, '..', 'apps', 'web', 'public', 'changelog.xml');

const PAGE_URL = `${SITE_URL}/changelog`;
const FEED_URL = `${SITE_URL}/changelog.xml`;
const FEED_TITLE = 'Unstream Changelog';
const FEED_DESCRIPTION =
  "What's new in Unstream — a running log of shipped features and improvements.";

interface ShippedFeature {
  id: string;
  title: string;
  description: string;
  date: string;
  announced?: boolean;
}

function main() {
  const features: ShippedFeature[] = JSON.parse(readFileSync(SOURCE_PATH, 'utf-8'));

  const items: RssItem[] = [];

  for (const feature of features) {
    const missing = (['id', 'title', 'description', 'date'] as const).filter((k) => !feature[k]);
    if (missing.length > 0) {
      console.warn(`Skipping entry ${feature.id || '(no id)'}: missing fields: ${missing.join(', ')}`);
      continue;
    }

    try {
      toRfc822(feature.date);
    } catch (e) {
      console.warn(`Skipping entry ${feature.id}: ${(e as Error).message}`);
      continue;
    }

    // The changelog is one page, so items link to the entry's anchor on it. ChangelogPage
    // renders each card with id={entry.id} to make that land — keep the two in step.
    const link = `${PAGE_URL}#${feature.id}`;

    items.push({
      title: feature.title,
      link,
      // Not the URL: the anchor would change if an entry were ever renamed, and a changed
      // guid shows up in every reader as a brand new item.
      guid: `unstream-changelog-${feature.id}`,
      pubDate: feature.date,
      description: feature.description,
      contentHtml:
        `<p>${escapeXml(feature.description)}</p>` +
        `<p><a href="${escapeXml(link)}">See it on Unstream</a></p>`,
    });
  }

  // Newest first. Ties (several features shipped the same day) keep their order in the
  // source file, which is the order the changelog page groups them in.
  items.sort((a, b) => b.pubDate.localeCompare(a.pubDate));

  const feed = buildRssFeed(
    { title: FEED_TITLE, description: FEED_DESCRIPTION, link: PAGE_URL, feedUrl: FEED_URL },
    items,
    new Date(),
  );

  writeFileSync(OUTPUT_PATH, feed);
  console.log(`Wrote ${items.length} changelog ${items.length === 1 ? 'entry' : 'entries'} to ${OUTPUT_PATH}`);
}

main();
