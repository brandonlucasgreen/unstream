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
 * Output: apps/web/public/dispatch.xml
 * Usage: npx tsx scripts/generate-dispatch-feed.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCH_DIR = join(__dirname, '..', 'data', 'dispatch');
const OUTPUT_PATH = join(__dirname, '..', 'apps', 'web', 'public', 'dispatch.xml');

const SITE_URL = 'https://unstream.stream';
const FEED_URL = `${SITE_URL}/dispatch.xml`;
const FEED_TITLE = 'The Unstream Dispatch';
const FEED_DESCRIPTION = 'Weekly music industry intelligence — platform news, streaming economics, and what it means for independent artists. Written by Unstream.';

const IGNORED_FILES = new Set(['README.md', 'PROMPT.md']);

interface DispatchEntry {
  slug: string;
  title: string;
  week: string;
  published: string;
  summary: string;
  bodyMarkdown: string;
}

function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\"/g, '"').replace(/\\'/g, "'");
    fields[key] = value;
  }
  return { fields, body: match[2].trim() };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRfc822(isoDate: string): string {
  // Interpret the date as 10:00 ET on that day (the publish time).
  // Using UTC -04:00 as a stable offset avoids DST surprises in the feed — RSS readers only care about ordering.
  const date = new Date(`${isoDate}T14:00:00Z`);
  return date.toUTCString();
}

function main() {
  const files = readdirSync(DISPATCH_DIR).filter(
    (f) => f.endsWith('.md') && !IGNORED_FILES.has(f)
  );

  const entries: DispatchEntry[] = [];

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

    entries.push({
      slug: basename(file, '.md'),
      title: fields.title,
      week: fields.week,
      published: fields.published,
      summary: fields.summary,
      bodyMarkdown: body,
    });
  }

  // Sort newest first
  entries.sort((a, b) => b.published.localeCompare(a.published));

  const now = new Date().toUTCString();

  const itemsXml = entries
    .map((entry) => {
      const html = marked.parse(entry.bodyMarkdown, { async: false }) as string;
      return `    <item>
      <title>${escapeXml(entry.title)}</title>
      <link>${escapeXml(`${SITE_URL}/dispatch/${entry.slug}`)}</link>
      <guid isPermaLink="false">unstream-dispatch-${escapeXml(entry.slug)}</guid>
      <pubDate>${toRfc822(entry.published)}</pubDate>
      <description>${escapeXml(entry.summary)}</description>
      <content:encoded><![CDATA[${html}]]></content:encoded>
    </item>`;
    })
    .join('\n');

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(FEED_TITLE)}</title>
    <link>${escapeXml(SITE_URL)}</link>
    <atom:link href="${escapeXml(FEED_URL)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(FEED_DESCRIPTION)}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;

  writeFileSync(OUTPUT_PATH, feed);
  console.log(`Wrote ${entries.length} dispatch${entries.length === 1 ? '' : 'es'} to ${OUTPUT_PATH}`);
}

main();
