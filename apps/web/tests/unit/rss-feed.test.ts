// @vitest-environment jsdom
// jsdom for DOMParser only — the feeds are asserted to actually parse as XML, not just to
// contain the right substrings.
import { describe, it, expect } from 'vitest';

// The build-time feed generators (changelog.xml, guides.xml, dispatch.xml) share this module.
// It lives in scripts/ because it only ever runs at build time, but its output is a public
// contract with feed readers and with Buttondown's RSS import, so it's tested with the rest.
import { escapeXml, toRfc822, parseFrontmatter, buildRssFeed } from '../../../../scripts/rss';

const CHANNEL = {
  title: 'Unstream Changelog',
  description: 'What shipped.',
  link: 'https://unstream.stream/changelog',
  feedUrl: 'https://unstream.stream/changelog.xml',
};

const NOW = new Date('2026-08-07T12:00:00Z');

function item(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Release pages',
    link: 'https://unstream.stream/changelog#release-pages',
    guid: 'unstream-changelog-release-pages',
    pubDate: '2026-08-02',
    description: 'Every format and price we can find.',
    ...overrides,
  };
}

describe('escapeXml', () => {
  it('escapes every character that could break out of an attribute or a text node', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f'
    );
  });

  it('escapes the ampersand first, so escapes are not double-escaped', () => {
    // Getting this order wrong turns `<` into `&amp;lt;`, which readers render literally.
    expect(escapeXml('<')).toBe('&lt;');
  });
});

describe('toRfc822', () => {
  it('formats an ISO date as an RFC 822 timestamp', () => {
    expect(toRfc822('2026-08-02')).toBe('Sun, 02 Aug 2026 14:00:00 GMT');
  });

  it('throws on a date it cannot parse rather than emitting "Invalid Date"', () => {
    expect(() => toRfc822('August 2nd')).toThrow(/Invalid published date/);
  });
});

describe('parseFrontmatter', () => {
  it('reads quoted and unquoted scalars and returns the body', () => {
    const parsed = parseFrontmatter('---\ntitle: "A guide"\npillar: how-to\n---\n\nBody text.');

    expect(parsed?.fields).toEqual({ title: 'A guide', pillar: 'how-to' });
    expect(parsed?.body).toBe('Body text.');
  });

  it('keeps colons inside a value', () => {
    const parsed = parseFrontmatter('---\ntitle: "Platforms: compared"\n---\nx');

    expect(parsed?.fields.title).toBe('Platforms: compared');
  });

  it('returns null when there is no frontmatter', () => {
    expect(parseFrontmatter('Just markdown.')).toBeNull();
  });
});

describe('buildRssFeed', () => {
  it('emits a well-formed channel with a self link and a stable guid', () => {
    const xml = buildRssFeed(CHANNEL, [item()], NOW);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<atom:link href="https://unstream.stream/changelog.xml" rel="self" type="application/rss+xml" />'
    );
    expect(xml).toContain('<guid isPermaLink="false">unstream-changelog-release-pages</guid>');
    expect(xml).toContain('<pubDate>Sun, 02 Aug 2026 14:00:00 GMT</pubDate>');
    expect(xml).toContain('<lastBuildDate>Fri, 07 Aug 2026 12:00:00 GMT</lastBuildDate>');
  });

  it('escapes markup in titles and descriptions', () => {
    const xml = buildRssFeed(CHANNEL, [
      item({ title: 'Bandcamp & <friends>', description: 'A "quoted" thing' }),
    ], NOW);

    expect(xml).toContain('<title>Bandcamp &amp; &lt;friends&gt;</title>');
    expect(xml).toContain('<description>A &quot;quoted&quot; thing</description>');
  });

  it('omits content:encoded when an item has no HTML body', () => {
    expect(buildRssFeed(CHANNEL, [item()], NOW)).not.toContain('content:encoded');
  });

  it('cannot be broken out of by a CDATA terminator in the body', () => {
    // A guide containing the literal `]]>` would otherwise end the CDATA section early and
    // corrupt every item after it.
    const xml = buildRssFeed(CHANNEL, [item({ contentHtml: '<p>a ]]> b</p>' })], NOW);

    expect(xml).toContain(']]]]><![CDATA[>');
    expect(() => parseXml(xml)).not.toThrow();
  });

  it('produces parseable XML for a realistic multi-item feed', () => {
    const xml = buildRssFeed(CHANNEL, [
      item(),
      item({ guid: 'g2', title: 'Café & Co', contentHtml: '<p>Héllo <em>world</em></p>' }),
    ], NOW);

    const doc = parseXml(xml);
    expect(doc.querySelectorAll('item').length).toBe(2);
  });
});

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(error.textContent || 'XML parse error');
  return doc;
}
