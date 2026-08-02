// iCalendar and Atom generation.
//
// Worth testing carefully because the failure mode is *silent*: a malformed .ics doesn't error
// in Apple Calendar, it just shows an empty subscription, and an unescaped comma truncates a
// release title at the comma without anything looking wrong. None of that is visible from
// reading the output — only from asserting the rules RFC 5545 actually imposes.

import { describe, it, expect } from 'vitest';
import {
  buildAtom,
  buildIcs,
  escapeIcsText,
  escapeXml,
  foldIcsLine,
  releasePageUrl,
  type FeedRelease,
} from '../../shared/feed-format';

const NOW = new Date('2026-08-01T12:00:00Z');

function release(over: Partial<FeedRelease> = {}): FeedRelease {
  return {
    artistName: 'Kid Lightbulbs',
    artistSlug: 'kid-lightbulbs',
    title: 'Infinite Normal',
    releaseSlug: 'infinite-normal',
    releaseDate: '2026-09-01',
    offerSummary: 'from $8 · ≈$6.80 to artist',
    platforms: ['Bandcamp', 'Mirlo'],
    ...over,
  };
}

/** Unfold a document back into logical lines, the way a real parser does. */
function logicalLines(ics: string): string[] {
  return ics.split('\r\n').reduce<string[]>((out, line) => {
    if (line.startsWith(' ') && out.length > 0) out[out.length - 1] += line.slice(1);
    else if (line) out.push(line);
    return out;
  }, []);
}

describe('escapeIcsText', () => {
  // A raw comma is a value separator in RFC 5545, so an unescaped one silently truncates the
  // title in the subscriber's calendar. Album titles have commas in them constantly.
  it('escapes the four characters that change meaning', () => {
    expect(escapeIcsText('Hello, World')).toBe('Hello\\, World');
    expect(escapeIcsText('A; B')).toBe('A\\; B');
    expect(escapeIcsText('back\\slash')).toBe('back\\\\slash');
    expect(escapeIcsText('one\ntwo')).toBe('one\\ntwo');
  });

  // Backslashes must be escaped before the escapes this function adds, or those get re-escaped.
  it('does not double-escape its own output', () => {
    expect(escapeIcsText('a\\,b')).toBe('a\\\\\\,b');
  });

  it('handles CRLF and bare CR as one newline each', () => {
    expect(escapeIcsText('a\r\nb')).toBe('a\\nb');
    expect(escapeIcsText('a\rb')).toBe('a\\nb');
  });
});

describe('foldIcsLine', () => {
  it('leaves a short line alone', () => {
    expect(foldIcsLine('SUMMARY:Short')).toBe('SUMMARY:Short');
  });

  it('folds a long line into 75-octet pieces with a leading space', () => {
    const folded = foldIcsLine('SUMMARY:' + 'a'.repeat(200));
    const lines = folded.split('\r\n');

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toHaveLength(75);
    for (const line of lines.slice(1)) expect(line.startsWith(' ')).toBe(true);
    // Unfolding must reproduce the original exactly.
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe('SUMMARY:' + 'a'.repeat(200));
  });

  // The reason folding counts octets rather than characters: splitting mid-sequence produces
  // mojibake or a parse error for a title like "Ágætis byrjun".
  it('never splits a multi-byte character across the boundary', () => {
    const folded = foldIcsLine('SUMMARY:' + 'é'.repeat(80)); // é is 2 bytes in UTF-8

    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      // A broken split would leave a replacement character behind.
      expect(line).not.toContain('�');
    }
    expect(folded.split('\r\n').map((l, i) => (i === 0 ? l : l.slice(1))).join(''))
      .toBe('SUMMARY:' + 'é'.repeat(80));
  });

  it('keeps every emitted line within 75 octets', () => {
    const folded = foldIcsLine('DESCRIPTION:' + 'ünstream '.repeat(40));
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('buildIcs', () => {
  it('produces a well-formed calendar with one event per release', () => {
    const ics = buildIcs([release()], 'Unstream — Upcoming releases', NOW);
    const lines = logicalLines(ics);

    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines.filter(l => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.filter(l => l === 'END:VEVENT')).toHaveLength(1);
  });

  // Bare LF is rejected outright by some clients.
  it('uses CRLF line endings throughout and ends with one', () => {
    const ics = buildIcs([release()], 'Cal', NOW);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  // A release date is a day, not a moment. An event at 00:00 UTC lands on the previous day for
  // every subscriber west of Greenwich.
  it('writes all-day events with an exclusive end date', () => {
    const lines = logicalLines(buildIcs([release({ releaseDate: '2026-09-01' })], 'Cal', NOW));

    expect(lines).toContain('DTSTART;VALUE=DATE:20260901');
    expect(lines).toContain('DTEND;VALUE=DATE:20260902');
    // No time component on the event bounds — a DATE-TIME value would look like
    // `...:20260901T000000Z`. (Checked against the value after the colon, since the property
    // name `VALUE=DATE` legitimately contains a T.)
    for (const prop of ['DTSTART', 'DTEND']) {
      const line = lines.find(l => l.startsWith(prop))!;
      expect(line.split(':')[1]).toMatch(/^\d{8}$/);
    }
  });

  it('rolls the end date over a month boundary correctly', () => {
    const lines = logicalLines(buildIcs([release({ releaseDate: '2026-09-30' })], 'Cal', NOW));
    expect(lines).toContain('DTEND;VALUE=DATE:20261001');
  });

  it('rolls over a leap day correctly', () => {
    const lines = logicalLines(buildIcs([release({ releaseDate: '2028-02-29' })], 'Cal', NOW));
    expect(lines).toContain('DTEND;VALUE=DATE:20280301');
  });

  // A subscribed calendar re-fetches forever. An unstable UID piles up a fresh copy of every
  // release on every refresh.
  it('gives each release a stable UID across rebuilds', () => {
    const first = logicalLines(buildIcs([release()], 'Cal', new Date('2026-08-01T00:00:00Z')));
    const second = logicalLines(buildIcs([release()], 'Cal', new Date('2026-12-25T00:00:00Z')));

    const uidOf = (lines: string[]) => lines.find(l => l.startsWith('UID:'));
    expect(uidOf(first)).toBe('UID:kid-lightbulbs-infinite-normal@unstream.stream');
    expect(uidOf(second)).toBe(uidOf(first));
  });

  it('gives two releases distinct UIDs', () => {
    const lines = logicalLines(
      buildIcs([release(), release({ releaseSlug: 'other', title: 'Other' })], 'Cal', NOW)
    );
    const uids = lines.filter(l => l.startsWith('UID:'));
    expect(new Set(uids).size).toBe(2);
  });

  it('escapes a comma in a release title rather than truncating it', () => {
    const lines = logicalLines(buildIcs([release({ title: 'Hello, Goodbye' })], 'Cal', NOW));
    const summary = lines.find(l => l.startsWith('SUMMARY:'));

    expect(summary).toContain('Hello\\, Goodbye');
  });

  // Pillar 3: a calendar entry deep-linking to one shop hides the payout comparison.
  it('links to the Unstream release page and shows the price', () => {
    const lines = logicalLines(buildIcs([release()], 'Cal', NOW));

    expect(lines).toContain('URL:https://unstream.stream/a/kid-lightbulbs/infinite-normal');
    const description = lines.find(l => l.startsWith('DESCRIPTION:')) ?? '';
    expect(description).toContain('Bandcamp\\, Mirlo');
    expect(description).toContain('to artist');
  });

  it('omits the price line rather than inventing one when no offer is known', () => {
    const lines = logicalLines(buildIcs([release({ offerSummary: '' })], 'Cal', NOW));
    const description = lines.find(l => l.startsWith('DESCRIPTION:')) ?? '';

    expect(description).not.toContain('undefined');
    expect(description).toContain('https://unstream.stream/a/');
  });

  it('produces a valid empty calendar when there is nothing coming', () => {
    const lines = logicalLines(buildIcs([], 'Cal', NOW));

    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
    expect(lines.filter(l => l === 'BEGIN:VEVENT')).toHaveLength(0);
  });

  it('folds a very long title so no physical line breaks the 75-octet rule', () => {
    const ics = buildIcs([release({ title: 'A'.repeat(300) })], 'Cal', NOW);

    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('buildAtom', () => {
  const opts = { title: 'Unstream', selfUrl: 'https://unstream.stream/feed/f/x.xml', feedId: 'tag:x' };

  it('produces a feed with one entry per release', () => {
    const xml = buildAtom([release()], opts, NOW);

    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml.match(/<entry>/g)).toHaveLength(1);
    expect(xml.trimEnd().endsWith('</feed>')).toBe(true);
  });

  it('escapes XML metacharacters in a title', () => {
    const xml = buildAtom([release({ title: 'Rock & Roll <b>' })], opts, NOW);

    expect(xml).toContain('Rock &amp; Roll &lt;b&gt;');
    expect(xml).not.toContain('<b>');
  });

  // A feed whose timestamp changes on every fetch tells every reader it changed.
  it('dates the feed from the newest release, not from now', () => {
    const xml = buildAtom(
      [release({ releaseDate: '2026-09-01' }), release({ releaseSlug: 'b', releaseDate: '2026-10-15' })],
      opts,
      NOW
    );

    expect(xml).toContain('<updated>2026-10-15T00:00:00Z</updated>');
  });

  it('falls back to now for an empty feed, since <updated> is required', () => {
    const xml = buildAtom([], opts, NOW);
    expect(xml).toContain('<updated>2026-08-01T12:00:00Z</updated>');
    expect(xml).not.toContain('<entry>');
  });

  it('gives each entry a stable, distinct id', () => {
    const xml = buildAtom([release(), release({ releaseSlug: 'other' })], opts, NOW);
    const ids = [...xml.matchAll(/<id>([^<]+)<\/id>/g)].map(m => m[1]);

    // One feed id plus two entry ids, all distinct.
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('tag:unstream.stream,2026:release/kid-lightbulbs/infinite-normal');
  });
});

describe('escapeXml', () => {
  it('escapes all five XML metacharacters', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes the ampersand first so entities are not mangled', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('releasePageUrl', () => {
  it('percent-encodes slugs', () => {
    expect(releasePageUrl('sigur rós', 'ágætis byrjun')).toBe(
      'https://unstream.stream/a/sigur%20r%C3%B3s/%C3%A1g%C3%A6tis%20byrjun'
    );
  });
});
