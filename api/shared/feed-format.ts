/**
 * Building iCalendar and Atom documents for release feeds.
 *
 * Pure string work, split out from the serving function for the same reason
 * `release-display.ts` was: it is fiddly, spec-governed, and a subscriber's calendar client
 * either parses it or silently shows nothing. A malformed feed fails *quietly* in Apple
 * Calendar — no error, just an empty subscription — so this is exactly the code that needs
 * tests rather than a look.
 *
 * Imported with an explicit `.ts` extension by any edge function (Deno requires it) and without
 * one by node, the same arrangement `release-display.ts` and `bandcamp-friday.ts` already use.
 */

export interface FeedRelease {
  artistName: string;
  artistSlug: string;
  title: string;
  releaseSlug: string;
  /** `YYYY-MM-DD`. Releases without one never reach here — there is no event to place. */
  releaseDate: string;
  /** "from $8 · ≈$6.80 to artist", or ''. Shown in the event description when present. */
  offerSummary: string;
  /**
   * Where you can buy it, artist-paying first — display name plus the platform's own page.
   *
   * Named `sources` rather than the old `platforms: string[]` because a bare list of names was
   * exactly the problem: a feed entry said "Bandcamp, Faircamp" and gave the reader no way to
   * reach either.
   */
  sources: { name: string; url: string }[];
  /** Cover art. Null when the release has none — never rendered as a broken image. */
  artworkUrl: string | null;
}

const SITE = 'https://unstream.stream';

export function releasePageUrl(artistSlug: string, releaseSlug: string): string {
  return `${SITE}/a/${encodeURIComponent(artistSlug)}/${encodeURIComponent(releaseSlug)}`;
}

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545)
// ---------------------------------------------------------------------------

/**
 * Escape a value for an iCalendar TEXT property.
 *
 * Order matters: backslashes first, or the escapes added below get re-escaped. Real release
 * titles hit every one of these — commas and semicolons are common in album names, and a raw
 * comma in a SUMMARY is a *value separator* in RFC 5545, so an unescaped one silently truncates
 * the title at the comma in the subscriber's calendar.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to 75 octets, per RFC 5545 §3.1.
 *
 * Counted in **UTF-8 bytes, not characters** — folding by `.length` would split a multi-byte
 * character across the boundary and produce mojibake or a parse failure in a title like
 * "Ágætis byrjun". Continuation lines start with a single space, which the parser strips.
 */
export function foldIcsLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let start = 0;
  // First line takes 75 octets; continuations take 74 plus the leading space.
  let limit = 75;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never cut inside a UTF-8 sequence: continuation bytes match 0b10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;

    const chunk = new TextDecoder().decode(bytes.slice(start, end));
    out.push(out.length === 0 ? chunk : ` ${chunk}`);
    start = end;
    limit = 74;
  }

  return out.join('\r\n');
}

/** `YYYY-MM-DD` → `YYYYMMDD`, the DATE form an all-day event uses. */
function icsDate(iso: string): string {
  return iso.replace(/-/g, '');
}

/** The day after `iso`, since DTEND on an all-day VEVENT is exclusive. */
function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return icsDate(date.toISOString().slice(0, 10));
}

/** UTC timestamp form for DTSTAMP. */
function icsTimestamp(now: Date): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * What an event says beyond its title: where to buy, for how much, and the links.
 *
 * The event's own `URL` property stays the Unstream release page — the same pillar-3 rule the
 * alerts follow, since a calendar entry that deep-links to one shop hides the payout comparison
 * at exactly the moment it matters. But `URL` is single-valued in RFC 5545, so the per-platform
 * links go in the description, one per line: naming "Bandcamp, Faircamp" without giving the
 * reader a way to reach either was the gap this closes.
 *
 * Written as bare URLs on their own lines because iCalendar DESCRIPTION is **plain text** — there
 * is no anchor markup to use, and every calendar client linkifies a bare URL. Anything cleverer
 * would show up as literal angle brackets in Apple Calendar.
 */
function eventDescription(release: FeedRelease): string {
  const parts: string[] = [];
  if (release.offerSummary) parts.push(release.offerSummary);
  parts.push(releasePageUrl(release.artistSlug, release.releaseSlug));

  for (const source of release.sources) {
    parts.push(`${source.name}: ${source.url}`);
  }

  return parts.join('\n');
}

/** Extensions Bandcamp and the other sources actually serve, onto iCalendar FMTTYPE values. */
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * `ATTACH` line for the cover art, or null.
 *
 * `FMTTYPE` is only declared when the extension actually says what the image is. Asserting
 * `image/jpeg` over a PNG is the kind of small lie that makes a client refuse the attachment
 * outright, and the parameter is optional — omitting it is better than guessing.
 *
 * The URI is **not** run through `escapeIcsText`: this is a URI value, not TEXT, and escaping
 * its commas to `\,` would corrupt the address. Same reason `URL:` below is unescaped.
 */
function artworkAttachLine(artworkUrl: string | null): string | null {
  if (!artworkUrl) return null;
  const ext = artworkUrl.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  const mime = IMAGE_MIME[ext];
  return mime ? `ATTACH;FMTTYPE=${mime}:${artworkUrl}` : `ATTACH:${artworkUrl}`;
}

/**
 * A whole calendar of releases.
 *
 * All-day events, because a release date is a day and not a moment — an event at "00:00 UTC"
 * lands on the wrong day for anyone west of Greenwich, which for a US subscriber means every
 * release shows up a day early.
 *
 * `uid` is derived from the artist and release slug, so re-fetching the feed updates the
 * existing entry instead of duplicating it — a subscribed calendar re-fetches indefinitely, and
 * an unstable UID would pile up a new copy of every release on every refresh.
 */
export function buildIcs(
  releases: FeedRelease[],
  calendarName: string,
  now: Date = new Date(),
  /** One line describing the calendar. Defaults to the per-fan feed's wording, since that is
   *  the primary feed; an artist feed passes its own, because "from the artists you support"
   *  is plainly untrue of a single artist's discography. */
  description = 'Upcoming releases from the artists you support on Unstream'
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Unstream//Release Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-CALDESC:${escapeIcsText(description)}`,
    // Clients that honour it back off to daily; a release calendar changes slowly.
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
  ];

  const stamp = icsTimestamp(now);

  for (const release of releases) {
    const attach = artworkAttachLine(release.artworkUrl);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${release.artistSlug}-${release.releaseSlug}@unstream.stream`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(release.releaseDate)}`,
      `DTEND;VALUE=DATE:${nextDay(release.releaseDate)}`,
      `SUMMARY:${escapeIcsText(`${release.artistName} — ${release.title}`)}`,
      `DESCRIPTION:${escapeIcsText(eventDescription(release))}`,
      `URL:${releasePageUrl(release.artistSlug, release.releaseSlug)}`,
      ...(attach ? [attach] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  // CRLF throughout, per RFC 5545 — bare LF is rejected outright by some clients.
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Atom
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The image's MIME type from its extension, defaulting to JPEG — what Bandcamp serves. */
function imageMimeType(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME[ext] ?? 'image/jpeg';
}

/**
 * The rich body of an entry: cover art, the price line, and a link per platform.
 *
 * Escaped **twice**, deliberately, and it is correct: values are escaped as they go into the
 * HTML, then `<content type="html">` requires the whole HTML string to be entity-encoded again
 * so it survives as XML character data. The reader decodes once to recover the HTML and renders
 * it. Getting this wrong in either direction either breaks the XML or shows visible tags.
 *
 * The artwork is hotlinked from wherever the platform serves it, same as the artist page already
 * does. Rehosting at feed scale raises rights questions this feature has not answered.
 */
function entryHtml(release: FeedRelease, pageUrl: string): string {
  const parts: string[] = [];

  if (release.artworkUrl) {
    parts.push(
      `<p><a href="${escapeXml(pageUrl)}"><img src="${escapeXml(release.artworkUrl)}" alt="${escapeXml(release.title)}" width="300"/></a></p>`
    );
  }

  if (release.offerSummary) parts.push(`<p>${escapeXml(release.offerSummary)}</p>`);

  if (release.sources.length > 0) {
    const links = release.sources
      .map(source => `<a href="${escapeXml(source.url)}">${escapeXml(source.name)}</a>`)
      .join(' &middot; ');
    parts.push(`<p>Buy on: ${links}</p>`);
  }

  parts.push(`<p><a href="${escapeXml(pageUrl)}">Compare where to buy on Unstream</a></p>`);
  return parts.join('');
}

/**
 * The same releases as an Atom feed, for RSS readers.
 *
 * `<updated>` on the feed is the newest release date rather than "now": a feed whose timestamp
 * changes on every fetch tells every reader it changed, which is how a quiet feed turns into a
 * noisy one. With no entries at all it falls back to `now`, since the element is required.
 */
export function buildAtom(
  releases: FeedRelease[],
  opts: { title: string; selfUrl: string; feedId: string },
  now: Date = new Date()
): string {
  const newest = releases.reduce<string | null>(
    (max, r) => (max === null || r.releaseDate > max ? r.releaseDate : max),
    null
  );
  const updated = newest ? `${newest}T00:00:00Z` : now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const entries = releases.map(release => {
    const url = releasePageUrl(release.artistSlug, release.releaseSlug);
    const summaryParts = [
      release.sources.length > 0 ? `On ${release.sources.map(x => x.name).join(', ')}` : '',
      release.offerSummary,
    ].filter(Boolean);

    return [
      '  <entry>',
      `    <title>${escapeXml(`${release.artistName} — ${release.title}`)}</title>`,
      `    <id>tag:unstream.stream,2026:release/${escapeXml(release.artistSlug)}/${escapeXml(release.releaseSlug)}</id>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      // One `rel="related"` per platform. A reader that renders the HTML content below gets the
      // links anyway; this is for the ones that only walk <link> elements.
      ...release.sources.map(
        source => `    <link rel="related" type="text/html" href="${escapeXml(source.url)}" title="${escapeXml(source.name)}"/>`
      ),
      // Podcast-style enclosure, which is how most readers find a per-entry image.
      ...(release.artworkUrl
        ? [`    <link rel="enclosure" type="${escapeXml(imageMimeType(release.artworkUrl))}" href="${escapeXml(release.artworkUrl)}"/>`]
        : []),
      `    <updated>${release.releaseDate}T00:00:00Z</updated>`,
      `    <author><name>${escapeXml(release.artistName)}</name></author>`,
      // `summary` stays plain text for readers that show only that; `content` carries the
      // artwork and the real links. Both are populated on purpose — a reader shows one or the
      // other and there is no way to know which.
      `    <summary>${escapeXml(summaryParts.join(' · ') || 'New release')}</summary>`,
      `    <content type="html">${escapeXml(entryHtml(release, url))}</content>`,
      '  </entry>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(opts.title)}</title>`,
    `  <id>${escapeXml(opts.feedId)}</id>`,
    `  <updated>${updated}</updated>`,
    `  <link rel="self" href="${escapeXml(opts.selfUrl)}"/>`,
    '  <generator uri="https://unstream.stream">Unstream</generator>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
