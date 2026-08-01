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
  ingestDiscogsMasters,
  mapDiscogsFormatToReleaseType,
  ingestDiscogsReleaseDetail,
  mapDiscogsFormatName,
  ingestMusicBrainzReleaseGroups,
  type DiscogsArtistReleaseEntry,
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

describe('mapDiscogsFormatToReleaseType', () => {
  it('reads the format string first', () => {
    expect(mapDiscogsFormatToReleaseType('Vinyl, LP, Album', 'Some Title')).toBe('album');
    expect(mapDiscogsFormatToReleaseType('CD, Compilation', 'Some Title')).toBe('compilation');
    expect(mapDiscogsFormatToReleaseType('Vinyl, 7", Single', 'Some Title')).toBe('single');
  });

  it('falls back to the title when the format string does not say', () => {
    expect(mapDiscogsFormatToReleaseType(null, 'Live at the Fillmore')).toBe('live');
    expect(mapDiscogsFormatToReleaseType('File, MP3', 'Acoustic Sessions EP')).toBe('ep');
  });

  it('defaults to other rather than guessing', () => {
    expect(mapDiscogsFormatToReleaseType('Vinyl, 12"', 'Untitled')).toBe('other');
    expect(mapDiscogsFormatToReleaseType(null, null)).toBe('other');
  });
});

function discogsEntry(opts: Partial<DiscogsArtistReleaseEntry> & { title: string }): DiscogsArtistReleaseEntry {
  return {
    id: 1,
    type: 'master',
    role: 'Main',
    main_release: 100,
    ...opts,
  } as DiscogsArtistReleaseEntry;
}

describe('ingestDiscogsMasters', () => {
  it('keeps only role=Main, type=master entries with a main_release', () => {
    const out = ingestDiscogsMasters([
      discogsEntry({ id: 1, main_release: 101, title: 'Real Album', format: 'Vinyl, LP, Album', year: 2015 }),
      discogsEntry({ id: 2, type: 'release', title: 'A Specific Pressing' }),
      discogsEntry({ id: 3, role: 'TrackAppearance', title: 'Featured On Someone Elses Comp' }),
      discogsEntry({ id: 4, main_release: undefined, title: 'Master With No Representative Release' }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'Real Album',
      matchKey: 'realalbum',
      releaseType: 'album',
      releaseDate: '2015-01-01',
      datePrecision: 'year',
      masterId: '1',
      mainReleaseId: '101',
    });
  });

  it('drops a master repeated across pages rather than double-counting it', () => {
    const out = ingestDiscogsMasters([
      discogsEntry({ id: 5, title: 'Repeated Master' }),
      discogsEntry({ id: 5, title: 'Repeated Master' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('assigns non-colliding slugs across two titles that would otherwise clash', () => {
    const out = ingestDiscogsMasters([
      discogsEntry({ id: 6, main_release: 201, title: 'A Record!' }),
      discogsEntry({ id: 7, main_release: 202, title: 'A Record?' }),
    ]);
    expect(new Set(out.map(o => o.slug)).size).toBe(2);
  });
});

describe('ingestDiscogsReleaseDetail', () => {
  it('maps a full date, one offer, and available when listings exist', () => {
    const out = ingestDiscogsReleaseDetail({
      released: '2015-03-31',
      formats: [{ name: 'Vinyl', descriptions: ['LP', 'Album'] }],
      num_for_sale: 12,
      lowest_price: 24.5,
    });

    expect(out.releaseDate).toBe('2015-03-31');
    expect(out.datePrecision).toBe('day');
    expect(out.offers).toEqual([
      { format: 'vinyl', price: 24.5, currency: 'USD', availability: 'available' },
    ]);
  });

  it('falls back to a year-only date when released is absent', () => {
    const out = ingestDiscogsReleaseDetail({ year: 1998, formats: [{ name: 'CD' }] });
    expect(out.releaseDate).toBe('1998-01-01');
    expect(out.datePrecision).toBe('year');
  });

  // Zero current listings is not the same claim as "sold out" — that implies stock existed
  // and ran out, but a release can simply have no active marketplace listings today.
  it('reports zero listings as unknown, never sold_out', () => {
    const out = ingestDiscogsReleaseDetail({
      formats: [{ name: 'Vinyl' }],
      num_for_sale: 0,
      lowest_price: null,
    });
    expect(out.offers[0].availability).toBe('unknown');
    expect(out.offers[0].price).toBeNull();
    expect(out.offers[0].currency).toBeNull();
  });

  it('emits no offer at all when there is no format data', () => {
    const out = ingestDiscogsReleaseDetail({ released: '2015' });
    expect(out.offers).toEqual([]);
  });

  it('emits only one offer even for a multi-format bundle, keyed to the first format', () => {
    // num_for_sale/lowest_price describe the whole release, not a per-format breakdown —
    // repeating the same aggregate price across every format would misrepresent a bundle
    // as several separately-buyable items at that price.
    const out = ingestDiscogsReleaseDetail({
      formats: [{ name: 'CD' }, { name: 'File' }],
      num_for_sale: 3,
      lowest_price: 9.99,
    });
    expect(out.offers).toHaveLength(1);
    expect(out.offers[0].format).toBe('cd');
  });
});

describe('mapDiscogsFormatName', () => {
  it('maps known Discogs format names', () => {
    expect(mapDiscogsFormatName('Vinyl')).toBe('vinyl');
    expect(mapDiscogsFormatName('CD')).toBe('cd');
    expect(mapDiscogsFormatName('Cassette')).toBe('cassette');
    expect(mapDiscogsFormatName('File')).toBe('digital');
  });

  it('is case-insensitive', () => {
    expect(mapDiscogsFormatName('vinyl')).toBe('vinyl');
  });

  it('reads descriptions when the name itself is unrecognized', () => {
    expect(mapDiscogsFormatName('Box Set', ['Book'])).toBe('book');
    expect(mapDiscogsFormatName('Box Set', ['Poster'])).toBe('merch');
  });

  it('defaults to other', () => {
    expect(mapDiscogsFormatName(null, [])).toBe('other');
    expect(mapDiscogsFormatName('8-Track Cartridge', [])).toBe('other');
  });
});

describe('ingestMusicBrainzReleaseGroups', () => {
  it('maps a release group into a matchable enrichment', () => {
    const out = ingestMusicBrainzReleaseGroups([
      {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Carrie & Lowell',
        'primary-type': 'Album',
        'secondary-types': [],
        'first-release-date': '2015-03-31',
      },
    ]);

    expect(out).toEqual([
      {
        matchKey: 'carrielowell',
        releaseType: 'album',
        releaseDate: '2015-03-31',
        datePrecision: 'day',
        mbid: '11111111-1111-1111-1111-111111111111',
      },
    ]);
  });

  it('keeps year-only precision rather than fabricating a day', () => {
    const out = ingestMusicBrainzReleaseGroups([
      { id: '22222222-2222-2222-2222-222222222222', title: 'Some Album', 'first-release-date': '1998' },
    ]);
    expect(out[0].releaseDate).toBe('1998-01-01');
    expect(out[0].datePrecision).toBe('year');
  });

  it('drops a duplicate id rather than emitting it twice', () => {
    const out = ingestMusicBrainzReleaseGroups([
      { id: '33333333-3333-3333-3333-333333333333', title: 'Dup' },
      { id: '33333333-3333-3333-3333-333333333333', title: 'Dup' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('skips a release group with no usable title', () => {
    const out = ingestMusicBrainzReleaseGroups([
      { id: '44444444-4444-4444-4444-444444444444', title: '...' },
    ]);
    expect(out).toHaveLength(0);
  });
});
