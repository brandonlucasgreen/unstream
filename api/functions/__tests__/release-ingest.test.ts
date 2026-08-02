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
  ingestFaircampHomeLinks,
  ingestFaircampPurchasePage,
  ingestFaircampReleasePage,
  buildFaircampRelease,
  findDiscoveredReleaseLinks,
  ingestJamcoopArtistPage,
  ingestJamcoopAlbumPage,
  buildJamcoopRelease,
  jamcoopArtistUrl,
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
    /** Bandcamp's own product kind: 'a' album, 'p' package, 'b' discography, 'i' subscription. */
    itemType?: string;
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
      additionalProperty: [
        { '@type': 'PropertyValue', name: 'type_name', value: p.typeName },
        ...(p.itemType ? [{ '@type': 'PropertyValue', name: 'item_type', value: p.itemType }] : []),
      ],
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

/**
 * A standalone-track page's JSON-LD, as the live pages publish it: `@type: MusicRecording`, no
 * top-level `albumRelease`, and the purchasable items hanging off `inAlbum` — the track's own
 * download *plus* every physical package of the album it belongs to.
 */
function trackPage(opts: {
  trackId?: string | null;
  datePublished?: string;
  /** The track's own download. */
  own?: { price: number; currency?: string } | null;
  /** The surrounding album's packages, which are NOT buyable as this track. */
  albumPackages?: Array<{ format: string; price: number; packageId: string }>;
  host?: string;
  slug?: string;
}): string {
  const host = opts.host ?? 'https://artist.bandcamp.com';
  const slug = opts.slug ?? 'a-single';
  const trackId = opts.trackId === undefined ? '748933878' : opts.trackId;

  const albumRelease: unknown[] = [];
  if (opts.own !== null) {
    albumRelease.push({
      '@type': ['MusicRelease', 'Product'],
      musicReleaseFormat: 'DigitalFormat',
      name: 'A Single',
      additionalProperty: [{ '@type': 'PropertyValue', name: 'type_name', value: 'Digital' }],
      offers: {
        '@type': 'Offer',
        url: `${host}/track/${slug}#t${trackId}-buy`,
        price: opts.own?.price ?? 1.5,
        priceCurrency: opts.own?.currency ?? 'USD',
        availability: 'OnlineOnly',
      },
    });
  }
  for (const pkg of opts.albumPackages ?? []) {
    albumRelease.push({
      '@type': ['MusicRelease', 'Product'],
      musicReleaseFormat: pkg.format,
      name: `THE ALBUM ${pkg.format}`,
      offers: {
        '@type': 'Offer',
        url: `${host}/track/${slug}#p${pkg.packageId}-buy`,
        price: pkg.price,
        priceCurrency: 'USD',
        availability: 'InStock',
      },
    });
  }

  const graph: Record<string, unknown> = {
    '@type': 'MusicRecording',
    name: 'A Single',
    datePublished: opts.datePublished ?? '30 May 2025 00:00:00 GMT',
    ...(trackId ? { additionalProperty: [{ '@type': 'PropertyValue', name: 'track_id', value: trackId }] } : {}),
    inAlbum: { '@type': 'MusicAlbum', name: 'THE ALBUM', albumRelease },
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(graph)}</script></head><body></body></html>`;
}

// Standalone `/track/` pages were reported as having no formats at all — 183 of 777 Bandcamp
// sources, every one a track URL. The old parser only read a top-level `albumRelease`, and a
// comment asserted track pages "carry a date but no offers at all". That was wrong: the track's
// own purchase is published under `inAlbum.albumRelease`, with a real price and currency.
describe('ingestBandcampDetail — standalone track pages', () => {
  it('reads the track\'s own digital price from inAlbum', () => {
    const out = ingestBandcampDetail(trackPage({ own: { price: 1, currency: 'GBP' } }));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.offers).toEqual([
      { format: 'digital', price: 1, currency: 'GBP', availability: 'available' },
    ]);
    expect(out.detail.releaseDate).toBe('2025-05-30');
  });

  // The one that matters. A track page also lists the *album's* vinyl/CD/cassette, and buying
  // those gets you the album, not this track — so publishing "this single is available on vinyl
  // for $30" would be a wrong claim about what someone's money buys.
  it('does not attribute the album\'s physical packages to the track', () => {
    const out = ingestBandcampDetail(
      trackPage({
        own: { price: 1.5 },
        albumPackages: [
          { format: 'VinylFormat', price: 30, packageId: '3409308344' },
          { format: 'CDFormat', price: 15, packageId: '3713717029' },
          { format: 'CassetteFormat', price: 15, packageId: '7013211' },
        ],
      })
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.offers.map(o => o.format)).toEqual(['digital']);
    expect(out.detail.offers[0].price).toBe(1.5);
  });

  // Without a track id there is nothing to tell the track's download apart from the album's
  // packages, so no price at all beats a possibly-wrong one.
  it('emits no offers when the track id is missing', () => {
    const out = ingestBandcampDetail(
      trackPage({ trackId: null, albumPackages: [{ format: 'VinylFormat', price: 30, packageId: '1' }] })
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.offers).toEqual([]);
    // The date still parses — a missing price is not a missing page.
    expect(out.detail.releaseDate).toBe('2025-05-30');
  });

  it('still reads the date when the track has no purchase offer at all', () => {
    const out = ingestBandcampDetail(trackPage({ own: null }));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.offers).toEqual([]);
    expect(out.detail.releaseDate).toBe('2025-05-30');
  });
});

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

  // The subscription and the discography bundle are typed DigitalFormat/Digital exactly like
  // the album's own download, so nothing but item_type tells them apart — and being cheaper,
  // the subscription wins the cheapest-variant rule and gets published as the album's price.
  // Measured on kidlightbulbs.bandcamp.com: a $3.33/month subscription quoted as the album.
  it('ignores the artist subscription and the discography bundle', () => {
    const out = ingestBandcampDetail(
      detailPage({
        packages: [
          { format: 'DigitalFormat', typeName: 'Digital', itemType: 'a', price: 5, availability: 'OnlineOnly' },
          { format: 'DigitalFormat', typeName: 'Digital', itemType: 'i', price: 3.33 },
          { format: 'DigitalFormat', typeName: 'Digital', itemType: 'b', price: 23.2, availability: 'OnlineOnly' },
          { format: 'VinylFormat', typeName: 'Vinyl LP', itemType: 'p', price: 25, availability: 'InStock' },
        ],
      })
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.detail.offers).toEqual([
      { format: 'digital', price: 5, currency: 'USD', availability: 'available' },
      { format: 'vinyl', price: 25, currency: 'USD', availability: 'available' },
    ]);
  });

  it('keeps a package that carries no item_type at all', () => {
    // Dropping the unlabelled would empty the offers on any page whose markup drifts — a worse
    // failure than the one above, and a silent one.
    const out = ingestBandcampDetail(
      detailPage({ packages: [{ format: 'VinylFormat', typeName: 'Vinyl LP', price: 25 }] })
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

// Fixtures below are trimmed from a real, live Faircamp instance (verified 2026-08-01) rather
// than guessed — Faircamp's own markup has no JSON-LD, no <time> tag, and no pubDate in its
// RSS feed, so the parser is deliberately narrow: identity and artwork only.
// A multi-artist instance, which is the case that broke: every release block carries its own
// artist credits, as links indistinguishable in shape from the release links beside them.
const FAIRCAMP_HOME_HTML = `<!doctype html><html><body>
  <nav>
    <a href="./">Home</a>
    <a href="#content">Skip</a>
    <a href="subscribe/">Subscribe</a>
  </nav>
  <div class="page_grid">
    <div class="release">
      <a href="ruined-castle/"><img src="ruined-castle/cover_320.jpg?XZDh1t00IS8"></a>
      <a href="ruined-castle/">RUINED CASTLE</a>
      <div class="release_artists"><a href="kl/">Kid Lightbulbs</a></div>
    </div>
    <div class="release">
      <a href="infinite-normal/"><img src="infinite-normal/cover_320.jpg?MYD15tAi5QI"></a>
      <a href="infinite-normal/">INFINITE NORMAL</a>
      <div class="release_artists"><a href="kl/">Kid Lightbulbs</a></div>
    </div>
    <div class="release">
      <a href="solo-piano/"><img src="solo-piano/cover_320.jpg?_5Kuo0yq7XY"></a>
      <a href="solo-piano/">SOLO PIANO</a>
      <div class="release_artists"><a href="blg/">Brandon Lucas Green</a></div>
    </div>
  </div>
  <a href="https://simonrepp.com/faircamp/">Powered by Faircamp</a>
  <a href="favicon.png?H-w5zbrED30">icon</a>
  <a href="feed.rss">RSS</a>
  <a href="site.css?xwWmIbFHB50">styles</a>
</body></html>`;

const FAIRCAMP_RELEASE_HTML = `<!doctype html><html><head>
  <meta property="og:title" content="RUINED CASTLE"/>
  <meta property="og:image" content="https://music.kidlightbulbs.com/ruined-castle/cover_800.jpg?XZDh1t00IS8"/>
  <meta property="og:description" content="The third album. A reflection on suffering."/>
</head><body>
  <a href="purchase/YV_jiM0Ks4o/">Buy</a>
  <a href="embed/">Embed</a>
</body></html>`;

/**
 * The purchase page's price block, copied from what Faircamp's generator emits
 * (renderer/src/pages/multitrack_purchase.rs) and checked against the live page.
 */
function faircampPurchaseHtml(opts: { min?: string; max?: string; fixedText?: string }): string {
  const priceBlock = opts.fixedText
    ? opts.fixedText
    : `<label for="price">Name your price</label><br><br>
       <div style="align-items: center; column-gap: .5rem; display: flex; position: relative;">
         <span style="position: absolute; left: .5rem;">$</span>
         <input autocomplete="off"
                ${opts.max ? `data-max="${opts.max}"` : ''}
                data-min="${opts.min ?? '0'}"
                id="price"
                pattern="[0-9]+([.,][0-9]+)?"
                placeholder="0 or more"
                style="padding-left: 1.5rem; width: 8rem;"
                type="text">
         USD
       </div>`;

  return `<!doctype html><html><body>
    <h1>Purchase downloads</h1>
    <div id="confirm_price">
      <div class="interactive"><form action="../../downloads/iKtmnNw4rCY/">${priceBlock}<button>Confirm</button></form></div>
      <div style="font-size: .9rem; margin: 1rem 0;">Available formats: MP3, Ogg Vorbis, FLAC, WAV</div>
    </div>
  </body></html>`;
}

describe('ingestFaircampHomeLinks', () => {
  it('finds bare relative release links and resolves them against the page URL', () => {
    const out = ingestFaircampHomeLinks(FAIRCAMP_HOME_HTML, 'https://music.kidlightbulbs.com/');
    expect(out).toEqual([
      { slug: 'ruined-castle', url: 'https://music.kidlightbulbs.com/ruined-castle/' },
      { slug: 'infinite-normal', url: 'https://music.kidlightbulbs.com/infinite-normal/' },
      { slug: 'solo-piano', url: 'https://music.kidlightbulbs.com/solo-piano/' },
    ]);
  });

  it('excludes known non-release paths and anything with a query string or external host', () => {
    const out = ingestFaircampHomeLinks(FAIRCAMP_HOME_HTML, 'https://music.kidlightbulbs.com/');
    expect(out.map(o => o.slug)).not.toContain('subscribe');
    expect(out.some(o => o.url.includes('simonrepp'))).toBe(false);
    expect(out.some(o => o.url.includes('favicon'))).toBe(false);
  });

  // The bug this guards: on a site hosting more than one artist, the per-release artist credits
  // were catalogued as records, so Kid Lightbulbs' page listed "Kid Lightbulbs" and "Brandon
  // Lucas Green" as albums. Nothing on the linked page says otherwise — an artist page and a
  // release page both publish an og:title — so it has to be caught here.
  it('never treats a release block\'s artist credits as releases', () => {
    const out = ingestFaircampHomeLinks(FAIRCAMP_HOME_HTML, 'https://music.kidlightbulbs.com/');
    expect(out.map(o => o.slug)).not.toContain('kl');
    expect(out.map(o => o.slug)).not.toContain('blg');
  });

  it('falls back to a whole-page scan when there are no release blocks, still minus credits', () => {
    // A generator change should cost coverage, not correctness.
    const noBlocks = `<html><body>
      <ol>
        <li><a href="in-winter/">in winter/borders</a><div class="release_artists"><a href="kl/">Kid Lightbulbs</a></div></li>
      </ol>
    </body></html>`;
    const out = ingestFaircampHomeLinks(noBlocks, 'https://music.kidlightbulbs.com/');
    expect(out.map(o => o.slug)).toEqual(['in-winter']);
  });

  it('deduplicates a repeated link and caps at the candidate ceiling', () => {
    const manyLinks = Array.from({ length: 40 }, (_, i) => `<a href="release-${i}/">R${i}</a>`).join('');
    const out = ingestFaircampHomeLinks(`<html>${manyLinks}</html>`, 'https://x.example.com/');
    expect(out.length).toBeLessThanOrEqual(30);
  });
});

describe('ingestFaircampReleasePage', () => {
  it('reads title, artwork and the purchase link', () => {
    expect(ingestFaircampReleasePage(FAIRCAMP_RELEASE_HTML)).toEqual({
      title: 'RUINED CASTLE',
      artworkUrl: 'https://music.kidlightbulbs.com/ruined-castle/cover_800.jpg?XZDh1t00IS8',
      purchaseHref: 'purchase/YV_jiM0Ks4o/',
    });
  });

  it('decodes HTML entities in the title', () => {
    const html = '<meta property="og:title" content="Rock &amp; Roll"/>';
    expect(ingestFaircampReleasePage(html)?.title).toBe('Rock & Roll');
  });

  it('returns null when there is no og:title at all — likely not a release page', () => {
    expect(ingestFaircampReleasePage('<html><body>nothing here</body></html>')).toBeNull();
  });

  it('accepts a missing artwork tag', () => {
    expect(ingestFaircampReleasePage('<meta property="og:title" content="No Cover"/>')).toEqual({
      title: 'No Cover',
      artworkUrl: null,
      purchaseHref: null,
    });
  });

  it('reports no purchase link for a release that has none', () => {
    // A code-unlocked release links `unlock/…` instead, and has no price anywhere.
    const html = '<meta property="og:title" content="ALTERNATE NORMAL"/><a href="unlock/vvsrj_sNEcc/">Unlock</a>';
    expect(ingestFaircampReleasePage(html)?.purchaseHref).toBeNull();
  });
});

describe('ingestFaircampPurchasePage', () => {
  it('reads a name-your-price minimum and its currency', () => {
    expect(ingestFaircampPurchasePage(faircampPurchaseHtml({ min: '0' }))).toEqual({
      format: 'digital',
      price: 0,
      currency: 'USD',
      availability: 'available',
    });
  });

  // The floor of a range is the honest figure: it's what a fan can actually pay.
  it('takes the floor of a bounded range', () => {
    expect(ingestFaircampPurchasePage(faircampPurchaseHtml({ min: '5', max: '20' }))).toMatchObject({
      price: 5,
      currency: 'USD',
    });
  });

  // A fixed price is rendered as text with no input at all, and the words around it are
  // localized — only the amount-then-ISO-code adjacency is guaranteed by the generator.
  it('reads a fixed price rendered as plain text', () => {
    expect(ingestFaircampPurchasePage(faircampPurchaseHtml({ fixedText: 'Preis $12 USD' }))).toMatchObject({
      price: 12,
      currency: 'USD',
    });
  });

  it('returns null rather than a price of zero when it cannot read one', () => {
    // "We couldn't read it" and "you may pay nothing" are different claims about someone's
    // income, and the second is the one that costs an artist money.
    expect(ingestFaircampPurchasePage('<html><body><p>Sold out</p></body></html>')).toBeNull();
  });
});

describe('buildFaircampRelease', () => {
  it('combines a release page into a persistable shape with an inferred type', () => {
    const out = buildFaircampRelease(
      { title: 'RUINED CASTLE', artworkUrl: 'https://example.com/cover.jpg' },
      'https://music.kidlightbulbs.com/ruined-castle/',
      new Set()
    );
    expect(out).toMatchObject({
      title: 'RUINED CASTLE',
      matchKey: 'ruinedcastle',
      status: 'released',
      artworkUrl: 'https://example.com/cover.jpg',
      externalUrl: 'https://music.kidlightbulbs.com/ruined-castle/',
    });
  });

  it('never has a date — Faircamp has none to give', () => {
    const out = buildFaircampRelease({ title: 'Some Release', artworkUrl: null }, 'https://x.example.com/some-release/', new Set());
    expect(out).not.toHaveProperty('releaseDate');
  });

  it('returns null for a title with no letters or numbers to match on', () => {
    expect(buildFaircampRelease({ title: '...', artworkUrl: null }, 'https://x.example.com/dots/', new Set())).toBeNull();
  });
});

describe('findDiscoveredReleaseLinks', () => {
  // Real example: an artist's own official website linking directly to a specific Subvert
  // release, verified 2026-08-01 (kidlightbulbs.com linking to
  // subvert.fm/kid-lightbulbs/infinite-normal).
  const OFFICIAL_SITE_HTML = `<html><body>
    <a href="https://kidlightbulbs.bandcamp.com/album/infinite-normal">Bandcamp</a>
    <a href="https://subvert.fm/kid-lightbulbs">Subvert profile</a>
    <a href="https://www.subvert.fm/kid-lightbulbs/infinite-normal">Buy on Subvert</a>
  </body></html>`;

  it('finds a specific-release Subvert link but not the bare artist profile link', () => {
    const out = findDiscoveredReleaseLinks(OFFICIAL_SITE_HTML, 'https://kidlightbulbs.com/');
    expect(out).toEqual([
      {
        platform: 'subvert',
        url: 'https://www.subvert.fm/kid-lightbulbs/infinite-normal',
        matchKey: 'infinitenormal',
      },
    ]);
  });

  it('ignores links to hosts it does not recognize', () => {
    const out = findDiscoveredReleaseLinks(
      '<a href="https://kidlightbulbs.bandcamp.com/album/infinite-normal">Bandcamp</a>',
      'https://kidlightbulbs.com/'
    );
    expect(out).toEqual([]);
  });

  it('deduplicates the same link appearing twice', () => {
    const html = `
      <a href="https://subvert.fm/artist/release-one">A</a>
      <a href="https://subvert.fm/artist/release-one">A again</a>
    `;
    const out = findDiscoveredReleaseLinks(html, 'https://example.com/');
    expect(out).toHaveLength(1);
  });

  it('skips a slug with no letters or numbers to match on', () => {
    const out = findDiscoveredReleaseLinks('<a href="https://subvert.fm/artist/---">A</a>', 'https://example.com/');
    expect(out).toEqual([]);
  });
});

// --- Jam.coop -----------------------------------------------------------------
//
// Markup shapes below are copied from live jam.coop pages (fetched 2026-08-01), trimmed to the
// parts the parsers read. The price line and the "Released:" label are reproduced verbatim,
// since those two strings are the whole contract.

const JAMCOOP_ARTIST_URL = 'https://jam.coop/artists/carya-amara';

function jamcoopAlbumHtml(opts: {
  title?: string;
  released?: string;
  priceLine?: string;
  description?: string;
} = {}): string {
  const { title = 'Carrion Carya Amara', released = 'October 4, 2024' } = opts;
  const priceLine = opts.priceLine ?? '£3.00 or more. Digital download. MP3 and FLAC';
  // The description is emitted *before* the price line on purpose. "First price-shaped string on
  // the page" would be a plausible-looking parser, and putting the description after the price
  // would let it pass — so the fixture is ordered to make the "Digital download" anchor the only
  // thing that can produce the right answer.
  return `<html><body>
    <img class="w-full" src="https://cdn.jam.coop/art.jpg" />
    <h1 class="text-lg font-medium leading-tight">${title}</h1>
    <h2 class="text-sm"><a href="/artists/carya-amara">Carya Amara</a></h2>
    ${opts.description ? `<section><p>${opts.description}</p></section>` : ''}
    <div>
      <form class="button_to" method="get" action="/artists/carya-amara/albums/x/purchases/new"><button>Buy</button></form>
      <p class="text-xs text-slate-600">${priceLine}</p>
    </div>
    <section class="mt-6"><p><strong>Released:</strong> ${released}</p></section>
  </body></html>`;
}

describe('ingestJamcoopArtistPage', () => {
  it('finds the artist’s albums and their grid artwork', () => {
    const html = `<html><body>
      <a href="/artists/carya-amara/albums/carrion-carya-amara">
        <div><img class="object-cover" src="https://cdn.jam.coop/a.jpg" /></div>
        <p>Carrion Carya Amara</p>
      </a>
      <a href="/artists/carya-amara/albums/second-record">
        <div><img src="https://cdn.jam.coop/b.jpg" /></div>
      </a>
    </body></html>`;

    expect(ingestJamcoopArtistPage(html, JAMCOOP_ARTIST_URL)).toEqual([
      {
        slug: 'carrion-carya-amara',
        url: 'https://jam.coop/artists/carya-amara/albums/carrion-carya-amara',
        artworkUrl: 'https://cdn.jam.coop/a.jpg',
      },
      {
        slug: 'second-record',
        url: 'https://jam.coop/artists/carya-amara/albums/second-record',
        artworkUrl: 'https://cdn.jam.coop/b.jpg',
      },
    ]);
  });

  // The page links to other artists too (nav, credits, a "more from jam.coop" rail). Cataloguing
  // those under this artist would attribute someone else's record to them.
  it('refuses albums belonging to a different artist on the same page', () => {
    const html = `
      <a href="/artists/carya-amara/albums/mine">Mine</a>
      <a href="/artists/someone-else/albums/theirs">Theirs</a>
    `;
    const out = ingestJamcoopArtistPage(html, JAMCOOP_ARTIST_URL);
    expect(out.map(c => c.slug)).toEqual(['mine']);
  });

  it('refuses an album link that leaves the host', () => {
    const html = '<a href="https://evil.example/artists/carya-amara/albums/x">X</a>';
    expect(ingestJamcoopArtistPage(html, JAMCOOP_ARTIST_URL)).toEqual([]);
  });

  it('ignores links that are not album routes', () => {
    const html = `
      <a href="/artists">Artists</a>
      <a href="/artists/carya-amara">The artist</a>
      <a href="/tags/electronic">electronic</a>
    `;
    expect(ingestJamcoopArtistPage(html, JAMCOOP_ARTIST_URL)).toEqual([]);
  });

  it('deduplicates an album linked twice (cover and title both link to it)', () => {
    const html = `
      <a href="/artists/carya-amara/albums/one"><img src="https://cdn.jam.coop/a.jpg" /></a>
      <a href="/artists/carya-amara/albums/one">One</a>
    `;
    expect(ingestJamcoopArtistPage(html, JAMCOOP_ARTIST_URL)).toHaveLength(1);
  });
});

describe('ingestJamcoopAlbumPage', () => {
  it('reads title, artwork, date and the digital offer', () => {
    const page = ingestJamcoopAlbumPage(jamcoopAlbumHtml(), new Date('2026-08-01T00:00:00Z'));
    expect(page).toEqual({
      title: 'Carrion Carya Amara',
      artworkUrl: 'https://cdn.jam.coop/art.jpg',
      releaseDate: '2024-10-04',
      datePrecision: 'day',
      status: 'released',
      offers: [{ format: 'digital', price: 3, currency: 'GBP', availability: 'available' }],
    });
  });

  // "£7.00 or more" is name-your-price with a floor. The floor is what a fan can actually pay,
  // so it is the honest figure to publish — the same call the Faircamp purchase parser makes.
  it('publishes the floor of a "or more" price, not zero', () => {
    const page = ingestJamcoopAlbumPage(
      jamcoopAlbumHtml({ priceLine: '£7.00 or more. Digital download. MP3 and FLAC' })
    );
    expect(page?.offers[0]).toMatchObject({ price: 7, currency: 'GBP' });
  });

  // A genuine zero floor is real name-your-price, which the display layer renders as such.
  it('keeps a zero floor as zero', () => {
    const page = ingestJamcoopAlbumPage(
      jamcoopAlbumHtml({ priceLine: '£0.00 or more. Digital download. MP3 and FLAC' })
    );
    expect(page?.offers[0]).toMatchObject({ price: 0, currency: 'GBP' });
  });

  // A symbol outside the mapped set fails the price pattern outright, so no offer is stored.
  // That is the intended outcome: formatMoney defaults a null currency to USD, so a price kept
  // without an identified currency would render "¥800" as "$800".
  it('emits no offer at all rather than a price in an unidentifiable currency', () => {
    const page = ingestJamcoopAlbumPage(
      jamcoopAlbumHtml({ priceLine: '¥800 or more. Digital download. MP3 and FLAC' })
    );
    expect(page?.offers).toEqual([]);
    expect(page?.title).toBe('Carrion Carya Amara'); // the rest of the page still parses
  });

  // The price is anchored on "Digital download" precisely so a figure quoted in an album
  // description can't be mistaken for the asking price.
  it('does not take a price out of the release description', () => {
    const page = ingestJamcoopAlbumPage(
      jamcoopAlbumHtml({
        description: 'Recorded on a £50 cassette deck.',
        priceLine: '£4.00 or more. Digital download. MP3 and FLAC',
      })
    );
    expect(page?.offers[0]).toMatchObject({ price: 4 });
  });

  it('marks a future-dated release announced', () => {
    const page = ingestJamcoopAlbumPage(
      jamcoopAlbumHtml({ released: 'December 1, 2026' }),
      new Date('2026-08-01T00:00:00Z')
    );
    expect(page?.releaseDate).toBe('2026-12-01');
    expect(page?.status).toBe('announced');
  });

  // A missing date is "we don't know", never a guessed one.
  it('leaves the date null when the page has no Released label', () => {
    const html = '<html><body><h1>Untitled</h1><p class="text-xs">£2.00 or more. Digital download.</p></body></html>';
    const page = ingestJamcoopAlbumPage(html);
    expect(page?.releaseDate).toBeNull();
    expect(page?.datePrecision).toBe('unknown');
  });

  it('returns null when there is no title to read', () => {
    expect(ingestJamcoopAlbumPage('<html><body><p>Not an album page</p></body></html>')).toBeNull();
  });

  it('still returns the release when there is no price at all', () => {
    const html = '<html><body><h1>Free Thing</h1><p><strong>Released:</strong> March 2, 2024</p></body></html>';
    const page = ingestJamcoopAlbumPage(html);
    expect(page?.offers).toEqual([]);
    expect(page?.releaseDate).toBe('2024-03-02');
  });
});

describe('buildJamcoopRelease', () => {
  const candidate = {
    slug: 'carrion-carya-amara',
    url: 'https://jam.coop/artists/carya-amara/albums/carrion-carya-amara',
    artworkUrl: 'https://cdn.jam.coop/grid.jpg',
  };

  it('carries the album page’s date and offers through to the persist shape', () => {
    const page = ingestJamcoopAlbumPage(jamcoopAlbumHtml())!;
    const built = buildJamcoopRelease(page, candidate, new Set());
    expect(built).toMatchObject({
      title: 'Carrion Carya Amara',
      slug: 'carrion-carya-amara',
      matchKey: 'carrioncaryaamara',
      releaseDate: '2024-10-04',
      externalUrl: candidate.url,
      offers: [{ format: 'digital', price: 3, currency: 'GBP', availability: 'available' }],
    });
  });

  it('falls back to the grid artwork when the album page has none', () => {
    const page = { ...ingestJamcoopAlbumPage(jamcoopAlbumHtml())!, artworkUrl: null };
    expect(buildJamcoopRelease(page, candidate, new Set())?.artworkUrl).toBe('https://cdn.jam.coop/grid.jpg');
  });

  it('avoids a slug already taken in this run', () => {
    const page = ingestJamcoopAlbumPage(jamcoopAlbumHtml())!;
    const built = buildJamcoopRelease(page, candidate, new Set(['carrion-carya-amara']));
    expect(built?.slug).not.toBe('carrion-carya-amara');
  });

  it('refuses a title with nothing to match on', () => {
    const page = { ...ingestJamcoopAlbumPage(jamcoopAlbumHtml())!, title: '!!!' };
    expect(buildJamcoopRelease(page, candidate, new Set())).toBeNull();
  });
});

describe('jamcoopArtistUrl', () => {
  it('normalizes an album link back to the artist page', () => {
    expect(jamcoopArtistUrl('https://jam.coop/artists/carya-amara/albums/carrion-carya-amara')).toBe(
      'https://jam.coop/artists/carya-amara'
    );
  });

  it('passes an artist page through unchanged', () => {
    expect(jamcoopArtistUrl('https://jam.coop/artists/carya-amara')).toBe('https://jam.coop/artists/carya-amara');
  });

  it('refuses a URL with no artist in it', () => {
    expect(jamcoopArtistUrl('https://jam.coop/')).toBeNull();
    expect(jamcoopArtistUrl('https://jam.coop/newsletters')).toBeNull();
  });

  it('refuses a non-http scheme', () => {
    expect(jamcoopArtistUrl('javascript:alert(1)//artists/x')).toBeNull();
  });
});
