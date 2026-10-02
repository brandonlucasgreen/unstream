import { describe, it, expect } from 'vitest';

// The weekly industry digest (scripts/industry-digest/) runs only in GitHub Actions, but its
// promise — every link in the digest came from a fetched source, never from the model — lives
// in these pure helpers, so they're tested with the rest.
import {
  extractJson,
  htmlToText,
  isoWeek,
  normalizeUrl,
  numberCandidates,
  parseFeed,
  renderMarkdown,
  selectCandidates,
  validateDigest,
  type RawCandidate,
} from '../../../../scripts/industry-digest/digest';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>MBW</title>
    <item>
      <title>Spotify changes royalty threshold &amp; more</title>
      <link>https://example.com/spotify?utm_source=rss</link>
      <pubDate>Wed, 30 Sep 2026 10:00:00 +0000</pubDate>
      <description><![CDATA[<p>The streamer said &#8217;no&#8217; to <b>small</b> artists.</p>]]></description>
    </item>
    <item>
      <title>No link here</title>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="html">Bandcamp Friday returns</title>
    <link rel="alternate" href="https://daily.bandcamp.com/features/friday"/>
    <link rel="self" href="https://daily.bandcamp.com/feed/1"/>
    <published>2026-10-01T09:00:00Z</published>
    <summary>Fees waived all day.</summary>
  </entry>
</feed>`;

function candidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    title: 'A story',
    url: 'https://example.com/a',
    source: 'MBW',
    publishedAt: '2026-09-30T10:00:00.000Z',
    excerpt: 'Text.',
    origin: 'feed',
    ...overrides,
  };
}

const SELECT = {
  since: new Date('2026-09-25T00:00:00Z'),
  previouslyCited: new Set<string>(),
  perSourceCap: 10,
  totalCap: 100,
};

describe('parseFeed', () => {
  it('reads RSS items, decoding entities and stripping HTML from the excerpt', () => {
    const items = parseFeed(RSS, 'MBW');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Spotify changes royalty threshold & more',
      url: 'https://example.com/spotify?utm_source=rss',
      source: 'MBW',
      publishedAt: '2026-09-30T10:00:00.000Z',
      excerpt: 'The streamer said ’no’ to small artists.',
      origin: 'feed',
    });
  });

  it('reads Atom entries, preferring the alternate link over self', () => {
    const [item] = parseFeed(ATOM, 'Bandcamp Daily');
    expect(item.url).toBe('https://daily.bandcamp.com/features/friday');
    expect(item.title).toBe('Bandcamp Friday returns');
    expect(item.publishedAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('throws on a document that is neither, so an HTML error page is not "no news"', () => {
    expect(() => parseFeed('<html><body>Just a moment...</body></html>', 'X')).toThrow(/not an RSS or Atom/);
  });
});

describe('htmlToText', () => {
  it('drops scripts and tags and collapses whitespace', () => {
    expect(htmlToText('<script>alert(1)</script><p>a\n\n<i>b</i>&nbsp;c</p>')).toBe('a b c');
  });
});

describe('normalizeUrl', () => {
  it('treats tracking parameters, www, trailing slashes and fragments as the same story', () => {
    expect(normalizeUrl('https://www.example.com/a/?utm_source=x&id=2#top')).toBe(
      normalizeUrl('https://example.com/a?id=2'),
    );
  });
});

describe('selectCandidates', () => {
  it('drops feed items outside the window but keeps undated search results', () => {
    const selected = selectCandidates(
      [
        candidate({ url: 'https://example.com/old', publishedAt: '2026-09-01T00:00:00.000Z' }),
        candidate({ url: 'https://example.com/undated-feed', publishedAt: null }),
        candidate({ url: 'https://example.com/new' }),
        candidate({ url: 'https://other.com/s', origin: 'search', publishedAt: null, source: 'other.com' }),
      ],
      SELECT,
    );
    expect(selected.map((c) => c.url)).toEqual(['https://example.com/new', 'https://other.com/s']);
  });

  it('prefers the dated feed copy when search finds the same story', () => {
    const selected = selectCandidates(
      [
        candidate({ url: 'https://example.com/a?utm_medium=s', origin: 'search', publishedAt: null, source: 'example.com' }),
        candidate({ url: 'https://example.com/a' }),
      ],
      SELECT,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].origin).toBe('feed');
  });

  it('excludes stories an earlier digest already cited', () => {
    const selected = selectCandidates([candidate()], {
      ...SELECT,
      previouslyCited: new Set([normalizeUrl('https://www.example.com/a/')]),
    });
    expect(selected).toHaveLength(0);
  });

  it('caps each source so one prolific feed cannot crowd out the rest', () => {
    const many = Array.from({ length: 5 }, (_, i) => candidate({ url: `https://example.com/${i}` }));
    const selected = selectCandidates([...many, candidate({ url: 'https://b.com/x', source: 'B' })], {
      ...SELECT,
      perSourceCap: 2,
    });
    expect(selected.map((c) => c.source)).toEqual(['MBW', 'MBW', 'B']);
  });
});

describe('extractJson', () => {
  it('finds the object inside a code fence and chatter', () => {
    expect(extractJson('Here you go:\n```json\n{"a": {"b": 1}}\n```')).toEqual({ a: { b: 1 } });
  });

  it('throws when there is no object', () => {
    expect(() => extractJson('Sorry, I cannot help.')).toThrow(/no JSON object/);
  });
});

const REPLY = {
  title: 'Spotify moves the line',
  summary: 'Royalties and Bandcamp Friday.',
  intro: 'A week about thresholds.',
  sections: [
    {
      heading: 'Streaming economics',
      stories: [
        { headline: 'Spotify raises threshold', body: 'It changed.\n\n# Not a heading', sourceIds: [1, 1, 2] },
        { headline: 'Invented story', body: 'Made up.', sourceIds: [99] },
      ],
    },
    { heading: 'Empty after drops', stories: [{ headline: 'Also invented', body: 'x', sourceIds: [] }] },
  ],
  forUnstream: ['Show the threshold on result cards', '', 42],
};

describe('validateDigest', () => {
  const valid = new Set([1, 2]);

  it('drops stories citing ids we never handed out, and sections left empty', () => {
    const { digest, dropped } = validateDigest(REPLY, valid);
    expect(digest.sections).toHaveLength(1);
    expect(digest.sections[0].stories).toHaveLength(1);
    expect(digest.sections[0].stories[0].sourceIds).toEqual([1, 2]);
    expect(dropped).toEqual(['Invented story', 'Also invented']);
    expect(digest.forUnstream).toEqual(['Show the threshold on result cards']);
  });

  it('flattens model prose to one line so it cannot inject markdown structure', () => {
    const { digest } = validateDigest(REPLY, valid);
    expect(digest.sections[0].stories[0].body).toBe('It changed. # Not a heading');
  });

  it('throws when nothing cites a valid id, so the caller retries instead of publishing nothing', () => {
    expect(() => validateDigest(REPLY, new Set([7]))).toThrow(/no story cites a valid source id/);
  });

  it('throws on a missing field', () => {
    expect(() => validateDigest({ ...REPLY, title: '' }, valid)).toThrow(/"title"/);
  });
});

describe('renderMarkdown', () => {
  const candidates = numberCandidates([
    candidate({ url: 'https://example.com/a b', source: 'MBW' }),
    candidate({ url: 'https://example.com/c', source: 'D[M]N' }),
  ]);

  it('renders links from candidates and escapes model text that would make links or HTML', () => {
    const { digest } = validateDigest(
      {
        ...REPLY,
        title: 'Say "hi"',
        sections: [
          {
            heading: 'News',
            stories: [{ headline: 'Click [here](https://evil.example)', body: '<img src=x>', sourceIds: [1, 2] }],
          },
        ],
      },
      new Set([1, 2]),
    );
    const md = renderMarkdown(digest, candidates, { week: '2026-W40', published: '2026-10-02', model: 'm' });

    expect(md).toContain('title: "Say \\"hi\\""');
    expect(md).toContain('### Click \\[here\\](https://evil.example)');
    expect(md).toContain('\\<img src=x\\>');
    expect(md).toContain('[MBW](<https://example.com/a%20b>) · [D\\[M\\]N](<https://example.com/c>)');
    expect(md).toContain('## For Unstream');
  });
});

describe('isoWeek', () => {
  it('matches `date +%G-W%V`, including across a year boundary', () => {
    expect(isoWeek(new Date('2026-10-02T11:17:00Z'))).toBe('2026-W40');
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2025-12-29T12:00:00Z'))).toBe('2026-W01');
  });
});
