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
  /** Platforms this release is on, artist-paying first. */
  platforms: string[];
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
 * What an event says beyond its title: where to buy, for how much, and the link back.
 *
 * The link is to the Unstream release page, never to one platform — the same pillar-3 rule the
 * alerts follow. A calendar entry that deep-links to one shop hides the payout comparison at
 * exactly the moment it matters.
 */
function eventDescription(release: FeedRelease): string {
  const parts: string[] = [];
  if (release.platforms.length > 0) parts.push(`On ${release.platforms.join(', ')}`);
  if (release.offerSummary) parts.push(release.offerSummary);
  parts.push(releasePageUrl(release.artistSlug, release.releaseSlug));
  return parts.join('\n');
}

/**
 * A whole calendar of upcoming releases.
 *
 * All-day events, because a release date is a day and not a moment — an event at "00:00 UTC"
 * lands on the wrong day for anyone west of Greenwich, which for a US subscriber means every
 * release shows up a day early.
 *
 * `uid` is derived from the artist and release slug, so re-fetching the feed updates the
 * existing entry instead of duplicating it — a subscribed calendar re-fetches indefinitely, and
 * an unstable UID would pile up a new copy of every release on every refresh.
 */
export function buildIcs(releases: FeedRelease[], calendarName: string, now: Date = new Date()): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Unstream//Release Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    'X-WR-CALDESC:Upcoming releases from the artists you support on Unstream',
    // Clients that honour it back off to daily; a release calendar changes slowly.
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
  ];

  const stamp = icsTimestamp(now);

  for (const release of releases) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${release.artistSlug}-${release.releaseSlug}@unstream.stream`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(release.releaseDate)}`,
      `DTEND;VALUE=DATE:${nextDay(release.releaseDate)}`,
      `SUMMARY:${escapeIcsText(`${release.artistName} — ${release.title}`)}`,
      `DESCRIPTION:${escapeIcsText(eventDescription(release))}`,
      `URL:${releasePageUrl(release.artistSlug, release.releaseSlug)}`,
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
      release.platforms.length > 0 ? `On ${release.platforms.join(', ')}` : '',
      release.offerSummary,
    ].filter(Boolean);

    return [
      '  <entry>',
      `    <title>${escapeXml(`${release.artistName} — ${release.title}`)}</title>`,
      `    <id>tag:unstream.stream,2026:release/${escapeXml(release.artistSlug)}/${escapeXml(release.releaseSlug)}</id>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      `    <updated>${release.releaseDate}T00:00:00Z</updated>`,
      `    <author><name>${escapeXml(release.artistName)}</name></author>`,
      `    <summary>${escapeXml(summaryParts.join(' · ') || 'Upcoming release')}</summary>`,
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
