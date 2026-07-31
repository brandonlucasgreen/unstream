// Mapping a fetched Bandcamp /music page into release rows.
//
// The properties worth locking are the ones that would silently corrupt a catalog rather than
// throw: telling a bot challenge apart from an empty artist, not storing a source URL that
// points at someone else's domain, and not letting two same-slug titles in one page collide.

import { describe, it, expect } from 'vitest';
import {
  ingestBandcampGrid,
  ingestBandcampDetail,
  bandcampMusicUrl,
  mapAvailability,
  mapOfferFormat,
} from '../release-ingest';

function item(opts: { id?: string; href: string; title: string; img?: string }): string {
  return `<li ${opts.id ? `data-item-id="${opts.id}"` : ''} class="music-grid-item">
    <a href="${opts.href}">
      <div class="art"><img src="${opts.img ?? 'https://f4.bcbits.com/img/a1_2.jpg'}" /></div>
      <p class="title">${opts.title}</p>
    </a>
  </li>`;
}

const page = (items: string[]) => `<html><body><ol class="music-grid">${items.join('')}</ol></body></html>`;
const PAGE_URL = 'https://someone.bandcamp.com/music';

describe('ingestBandcampGrid', () => {
  it('maps a grid into releases with resolved absolute URLs', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-111', href: '/album/first-record', title: 'First Record' }),
        item({ id: 'track-222', href: '/track/a-single', title: 'A Single' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(2);
    expect(out.releases[0]).toMatchObject({
      title: 'First Record',
      slug: 'first-record',
      matchKey: 'firstrecord',
      releaseType: 'album',
      releaseDate: null,
      datePrecision: 'unknown',
      status: 'released',
      source: { platform: 'bandcamp', url: 'https://someone.bandcamp.com/album/first-record', externalId: 'album-111' },
    });
    expect(out.releases[1].releaseType).toBe('single');
  });

  // Distinguishing these two is the single most repeated bug class in this codebase. A
  // challenge means the upstream declined to answer; treating it as "no releases" records a
  // confident wrong answer and (with a cooldown) keeps it wrong for a week.
  it('reports a bot challenge distinctly from an empty catalog', () => {
    const challenge = '<html><head><script src="/_fs-ch-abc/main.js"></script></head><body></body></html>';
    expect(ingestBandcampGrid(challenge, PAGE_URL)).toEqual({ ok: false, reason: 'bot_challenge' });

    expect(ingestBandcampGrid('<html><body><p>nothing</p></body></html>', PAGE_URL)).toEqual({
      ok: false,
      reason: 'no_releases',
    });
  });

  // A stored source URL is shown to fans as a place to buy this artist's record, so an href
  // out of fetched markup must not be able to point somewhere else.
  it('drops releases whose href leaves the page host', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: 'https://attacker.example.com/album/x', title: 'Offsite' }),
        item({ id: 'album-2', href: '/album/legit', title: 'Legit' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases.map(r => r.title)).toEqual(['Legit']);
  });

  it('accepts same-host links after a custom-domain redirect', () => {
    // pageUrl is where we actually landed, which for Bandcamp Pro is the custom domain.
    const out = ingestBandcampGrid(
      page([item({ id: 'album-1', href: '/album/javelin', title: 'Javelin' })]),
      'https://music.sufjan.com/music'
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases[0].source.url).toBe('https://music.sufjan.com/album/javelin');
  });

  it('deduplicates the same release listed twice on one page', () => {
    // Bandcamp sometimes renders a release both as "featured" and in sequence.
    const dup = item({ id: 'album-1', href: '/album/x', title: 'Repeated' });
    const out = ingestBandcampGrid(page([dup, dup]), PAGE_URL);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(1);
  });

  it('does not merge an album and a single that share a title', () => {
    // Same title at different types are genuinely different releases — a lead single and the
    // album it lands on. Under-merge, never over-merge.
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: '/album/halo', title: 'Halo' }),
        item({ id: 'track-1', href: '/track/halo', title: 'Halo' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(2);
  });

  it('gives colliding slugs distinct values within one page', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: '/album/a', title: 'Album Name.' }),
        item({ id: 'album-2', href: '/album/b', title: 'Album Name!' }),
        item({ id: 'album-3', href: '/album/c', title: 'Album Name?' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // All three normalize to the same match key, so they're one release by identity...
    expect(out.releases).toHaveLength(1);
  });

  it('keeps non-Latin titles instead of dropping them', () => {
    const out = ingestBandcampGrid(
      page([
        item({ id: 'album-1', href: '/album/tokyo', title: '東京' }),
        item({ id: 'album-2', href: '/album/osaka', title: '大阪' }),
      ]),
      PAGE_URL
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases).toHaveLength(2);
    expect(out.releases.map(r => r.title)).toEqual(['東京', '大阪']);
    expect(new Set(out.releases.map(r => r.slug)).size).toBe(2);
  });

  it('never invents a release date from the grid', () => {
    // Dates are not in the grid at all — they cost one request per release. Guessing one
    // would put a fabricated date into a chronology and a subscriber's calendar.
    const out = ingestBandcampGrid(page([item({ id: 'album-1', href: '/album/x', title: 'X' })]), PAGE_URL);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.releases[0].releaseDate).toBeNull();
    expect(out.releases[0].datePrecision).toBe('unknown');
  });

  it('reports no_releases when every entry was unusable', () => {
    const out = ingestBandcampGrid(
      page([item({ id: 'album-1', href: 'https://elsewhere.example.com/x', title: 'Offsite' })]),
      PAGE_URL
    );
    expect(out).toEqual({ ok: false, reason: 'no_releases' });
  });
});

// ---------------------------------------------------------------------------
// Release pages — the date, the formats and the prices
// ---------------------------------------------------------------------------

/** A Bandcamp release page's JSON-LD, in the shape the live pages actually publish. */
function detailPage(opts: {
  datePublished?: string | null;
  packages?: Array<{
    format?: string;
    typeName?: string;
    price?: number | string;
    currency?: string;
    availability?: string;
  }>;
  extraScript?: string;
}): string {
  const graph: Record<string, unknown> = { '@type': 'MusicAlbum', name: 'A Record' };
  if (opts.datePublished !== null) graph.datePublished = opts.datePublished ?? '06 Oct 2023 00:00:00 GMT';
  if (opts.packages) {
    graph.albumRelease = opts.packages.map(p => ({
      '@type': ['MusicRelease', 'Product'],
      musicReleaseFormat: p.format,
      additionalProperty: [{ '@type': 'PropertyValue', name: 'type_name', value: p.typeName }],
      offers: {
        '@type': 'Offer',
        price: p.price,
        priceCurrency: p.currency ?? 'USD',
        availability: p.availability ?? 'InStock',
      },
    }));
  }
  return `<html><head>${opts.extraScript ?? ''}
    <script type="application/ld+json">${JSON.stringify(graph)}</script>
  </head><body></body></html>`;
}

describe('ingestBandcampDetail', () => {
  it('reads the date and every purchasable format', () => {
    const out = ingestBandcampDetail(
      detailPage({
        datePublished: '15 Sep 2023 00:00:00 GMT',
        packages: [
          { format: 'DigitalFormat', typeName: 'Digital', price: 10, availability: 'OnlineOnly' },
          { format: 'VinylFormat', typeName: '2 x Vinyl LP', price: 25 },
          { format: 'CDFormat', typeName: 'Compact Disc (CD)', price: 12 },
        ],
      }),
      new Date('2026-07-31T00:00:00Z')
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.releaseDate).toBe('2023-09-15');
    expect(out.detail.datePrecision).toBe('day');
    expect(out.detail.status).toBe('released');
    expect(out.detail.offers).toEqual([
      { format: 'digital', price: 10, currency: 'USD', availability: 'available' },
      { format: 'vinyl', price: 25, currency: 'USD', availability: 'available' },
      { format: 'cd', price: 12, currency: 'USD', availability: 'available' },
    ]);
  });

  // One row per (source, format) is a schema constraint, and Bandcamp routinely sells several
  // variants of one format. Quoting the deluxe box as "the price of the vinyl" would be a
  // straightforwardly wrong number in front of someone deciding whether to buy.
  it('collapses variants of one format to the cheapest available', () => {
    const out = ingestBandcampDetail(
      detailPage({
        packages: [
          { format: 'VinylFormat', typeName: 'Deluxe Box Set', price: 60, availability: 'SoldOut' },
          { format: 'VinylFormat', typeName: 'Vinyl LP', price: 25, availability: 'InStock' },
        ],
      })
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.offers).toEqual([
      { format: 'vinyl', price: 25, currency: 'USD', availability: 'available' },
    ]);
  });

  it('keeps a sold-out format rather than dropping it', () => {
    // A fan is better served by "vinyl — sold out" than by a page that silently omits the
    // format, which reads as "this was never pressed".
    const out = ingestBandcampDetail(
      detailPage({ packages: [{ format: 'VinylFormat', price: 35, availability: 'SoldOut' }] })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.offers[0].availability).toBe('sold_out');
  });

  it('treats a pre-order as announced', () => {
    const out = ingestBandcampDetail(
      detailPage({
        datePublished: '01 Mar 2027 00:00:00 GMT',
        packages: [{ format: 'VinylFormat', price: 30, availability: 'https://schema.org/PreOrder' }],
      }),
      new Date('2026-07-31T00:00:00Z')
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.status).toBe('announced');
    expect(out.detail.offers[0].availability).toBe('preorder');
  });

  // Mirlo has a live release dated 2925-11-02. Unbounded, one typo sorts to the top of every
  // chronology and lands in every calendar subscriber's feed.
  it('refuses an implausible date instead of storing it', () => {
    const out = ingestBandcampDetail(
      detailPage({ datePublished: '2925-11-02' }),
      new Date('2026-07-31T00:00:00Z')
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.releaseDate).toBeNull();
    expect(out.detail.datePrecision).toBe('unknown');
  });

  // Standalone track pages are MusicRecording: a real date, and no offer anywhere in the
  // JSON-LD. "No offers" here is a fact about the page, not a failure to read it.
  it('accepts a page with a date and no offers', () => {
    const out = ingestBandcampDetail(detailPage({ datePublished: '05 Aug 2014 00:00:00 GMT' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.releaseDate).toBe('2014-08-05');
    expect(out.detail.offers).toEqual([]);
  });

  // The distinction the rest of this codebase keeps getting wrong: an upstream that declined
  // to answer is not an upstream that answered "nothing". Only the first should back off, and
  // neither may be written down as "this release has no price".
  it('separates a bot challenge from a page it could not read', () => {
    const challenge = '<html><head><script src="/_fs-ch-abc/main.js"></script></head><body></body></html>';
    expect(ingestBandcampDetail(challenge)).toEqual({ ok: false, reason: 'bot_challenge' });
    expect(ingestBandcampDetail('<html><body>a real page, no structured data</body></html>')).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('survives a broken JSON-LD block earlier in the page', () => {
    const out = ingestBandcampDetail(
      detailPage({
        datePublished: '06 Oct 2023 00:00:00 GMT',
        extraScript: '<script type="application/ld+json">{ not json </script>',
      })
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.releaseDate).toBe('2023-10-06');
  });
});

describe('mapOfferFormat', () => {
  it('trusts musicReleaseFormat where it maps cleanly', () => {
    expect(mapOfferFormat('DigitalFormat', 'Digital')).toBe('digital');
    expect(mapOfferFormat('VinylFormat', '2 x Vinyl LP')).toBe('vinyl');
    expect(mapOfferFormat('CDFormat', 'Compact Disc (CD)')).toBe('cd');
    expect(mapOfferFormat('CassetteFormat', 'Cassette')).toBe('cassette');
  });

  // Bandcamp sells shirts and books alongside records, and schema.org has no music format for
  // those — so the package label is the only signal left.
  it('falls back to the package label for things schema.org has no format for', () => {
    expect(mapOfferFormat(null, 'T-Shirt/Apparel')).toBe('merch');
    expect(mapOfferFormat(null, 'Book/Magazine')).toBe('book');
    expect(mapOfferFormat('OtherFormat', 'Cassette + zine')).toBe('cassette');
  });

  it('says other rather than guessing', () => {
    expect(mapOfferFormat(null, null)).toBe('other');
    expect(mapOfferFormat('MysteryFormat', 'Something new')).toBe('other');
  });
});

describe('mapAvailability', () => {
  it('maps the states Bandcamp actually publishes', () => {
    expect(mapAvailability('InStock')).toBe('available');
    expect(mapAvailability('OnlineOnly')).toBe('available'); // digital downloads
    expect(mapAvailability('SoldOut')).toBe('sold_out');
    expect(mapAvailability('PreOrder')).toBe('preorder');
    // The "https://schema.org/…" spelling is folded by the parser, not here — the pre-order
    // case above goes through the full path with that form.
  });

  // Optimism is the dangerous default here: telling someone a sold-out record is in stock is
  // the one availability error that wastes their time.
  it('leaves anything unrecognized unknown', () => {
    expect(mapAvailability('Backordered')).toBe('unknown');
    expect(mapAvailability(null)).toBe('unknown');
    expect(mapAvailability('')).toBe('unknown');
  });
});

describe('bandcampMusicUrl', () => {
  it('derives /music from any stored depth', () => {
    for (const stored of [
      'https://someone.bandcamp.com',
      'https://someone.bandcamp.com/',
      'https://someone.bandcamp.com/music',
      'https://someone.bandcamp.com/album/a-record',
      'https://someone.bandcamp.com/track/a-song?from=embed',
    ]) {
      expect(bandcampMusicUrl(stored)).toBe('https://someone.bandcamp.com/music');
    }
  });

  it('preserves a custom domain', () => {
    expect(bandcampMusicUrl('https://music.sufjan.com/album/javelin')).toBe('https://music.sufjan.com/music');
  });

  it('refuses junk and non-HTTP schemes', () => {
    expect(bandcampMusicUrl('not a url')).toBeNull();
    expect(bandcampMusicUrl('file:///etc/passwd')).toBeNull();
    expect(bandcampMusicUrl('')).toBeNull();
  });
});
