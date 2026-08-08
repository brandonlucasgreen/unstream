/**
 * Shared RSS 2.0 helpers for the build-time feed generators.
 *
 * Three feeds are written into apps/web/public at build time — dispatch.xml,
 * changelog.xml and guides.xml. They had one hand-rolled XML builder each until
 * the second one was added; this module is the single copy, so a fix to date
 * formatting or escaping lands in every feed at once.
 *
 * RSS 2.0 rather than Atom because the consumers are feed readers and
 * Buttondown's RSS-to-email import, and RSS 2.0 is what both treat as the
 * lowest-common-denominator. (The private release feeds in api/shared/
 * feed-format.ts are Atom + iCalendar — a different job for different clients.)
 */

export const SITE_URL = 'https://unstream.stream';

export interface RssItem {
  title: string;
  /** Absolute URL of the item's page. */
  link: string;
  /** Stable, permanent identifier. Readers dedupe on this, so it must never change. */
  guid: string;
  /** ISO date, YYYY-MM-DD. */
  pubDate: string;
  /** Plain-text summary. */
  description: string;
  /** Optional full HTML body, emitted as content:encoded. */
  contentHtml?: string;
}

export interface RssChannel {
  title: string;
  description: string;
  /** Absolute URL of the page the feed represents. */
  link: string;
  /** Absolute URL of the feed itself, for <atom:link rel="self">. */
  feedUrl: string;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Turn a YYYY-MM-DD date into an RFC 822 timestamp.
 *
 * Interpret the date as 10:00 ET on that day (the publish time). Using UTC -04:00 as a stable
 * offset avoids DST surprises in the feed — RSS readers only care about ordering.
 */
export function toRfc822(isoDate: string): string {
  const date = new Date(`${isoDate}T14:00:00Z`);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid published date: "${isoDate}" — use YYYY-MM-DD format`);
  }
  return date.toUTCString();
}

/**
 * Split YAML frontmatter from the markdown body.
 *
 * Deliberately a flat key/value reader rather than a YAML parser: every field these feeds
 * read is a one-line scalar, and adding a dependency to parse them would be more code than
 * this is. Returns null when the file has no frontmatter at all.
 */
export function parseFrontmatter(
  content: string,
): { fields: Record<string, string>; body: string } | null {
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

/**
 * Wrap HTML in a CDATA section, escaping the terminator so body content can never
 * break out of it and corrupt the surrounding XML.
 */
function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function buildRssFeed(channel: RssChannel, items: RssItem[], now: Date): string {
  const itemsXml = items
    .map((item) => {
      const content = item.contentHtml
        ? `\n      <content:encoded>${cdata(item.contentHtml)}</content:encoded>`
        : '';
      return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      <pubDate>${toRfc822(item.pubDate)}</pubDate>
      <description>${escapeXml(item.description)}</description>${content}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${escapeXml(channel.link)}</link>
    <atom:link href="${escapeXml(channel.feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(channel.description)}</description>
    <language>en-us</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>
`;
}
