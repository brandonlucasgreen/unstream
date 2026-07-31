// parseBandcampGridReleases — the catalog-building read of a Bandcamp /music page.
//
// The grid markup below is copied from a live page (sufjanstevens.bandcamp.com/music,
// fetched 2026-07-31) rather than invented, including its real whitespace and attribute
// order, so a Bandcamp markup change shows up here as a failure instead of as silently
// empty catalogs in production.

import { describe, it, expect } from 'vitest';
import {
  parseBandcampGridReleases,
  parseBandcampReleaseCounts,
  parseBandcampReleaseTitles,
} from '../search-parsers';

/** Real grid-item markup, verbatim in shape. */
function gridItem(opts: {
  itemId?: string;
  href: string;
  title: string;
  img?: string;
  lazyImg?: string;
}): string {
  const img = opts.lazyImg
    ? `<img data-original="${opts.lazyImg}" src="data:image/gif;base64,R0lGOD" alt="" />`
    : opts.img === undefined
      ? '<img src="https://f4.bcbits.com/img/a1059506682_2.jpg" alt="" />'
      : opts.img === ''
        ? ''
        : `<img src="${opts.img}" alt="" />`;

  return `
<li ${opts.itemId ? `data-item-id="${opts.itemId}"` : ''}
    data-band-id="203035041"
    class="music-grid-item square first-four

    "
    data-bind="css: {'featured': featured()}"
>
    <a href="${opts.href}">
        <div class="art">
            ${img}
        </div>
        <p class="title">
            ${opts.title}
        </p>
    </a>
</li>`;
}

function page(items: string[]): string {
  return `<html><body><ol class="editable-grid music-grid">${items.join('\n')}</ol></body></html>`;
}

const REAL_PAGE = page([
  gridItem({
    itemId: 'album-1891263657',
    href: '/album/carrie-lowell-10th-anniversary-edition',
    title: 'Carrie &amp; Lowell (10th Anniversary Edition)',
  }),
  gridItem({ itemId: 'album-2222222222', href: '/album/javelin', title: 'Javelin' }),
  gridItem({ itemId: 'track-3333333333', href: '/track/goodbye-evergreen', title: 'Goodbye Evergreen' }),
]);

describe('parseBandcampGridReleases', () => {
  it('reads id, type, href, title and artwork from a real grid', () => {
    const releases = parseBandcampGridReleases(REAL_PAGE);

    expect(releases).toHaveLength(3);
    expect(releases[0]).toEqual({
      externalId: 'album-1891263657',
      type: 'album',
      href: '/album/carrie-lowell-10th-anniversary-edition',
      title: 'Carrie & Lowell (10th Anniversary Edition)',
      artworkUrl: 'https://f4.bcbits.com/img/a1059506682_2.jpg',
    });
  });

  // The id is worth more than the title for identity: an artist can rename a release and
  // the id doesn't move, so re-reading a page updates a row rather than creating a second.
  it('captures the stable per-release id that the titles parser throws away', () => {
    const ids = parseBandcampGridReleases(REAL_PAGE).map(r => r.externalId);
    expect(ids).toEqual(['album-1891263657', 'album-2222222222', 'track-3333333333']);
  });

  it('distinguishes albums from tracks by the id prefix', () => {
    const byType = parseBandcampGridReleases(REAL_PAGE).map(r => r.type);
    expect(byType).toEqual(['album', 'album', 'track']);
  });

  it('keeps display-quality titles, unlike the match-key parser', () => {
    const titles = parseBandcampGridReleases(REAL_PAGE).map(r => r.title);
    // Entity-decoded, original case and punctuation intact.
    expect(titles[0]).toBe('Carrie & Lowell (10th Anniversary Edition)');

    // Contrast: the existing parser folds and strips for matching purposes.
    const matchTitles = parseBandcampReleaseTitles(REAL_PAGE);
    expect(matchTitles[0]).not.toBe(titles[0]);
  });

  it('preserves accents and non-Latin characters in titles', () => {
    const releases = parseBandcampGridReleases(
      page([
        gridItem({ itemId: 'album-1', href: '/album/takk', title: 'Takk... — Sigur Rós' }),
        gridItem({ itemId: 'album-2', href: '/album/tokyo', title: '東京' }),
      ])
    );
    expect(releases[0].title).toBe('Takk... — Sigur Rós');
    expect(releases[1].title).toBe('東京');
  });

  it('reads lazy-loaded artwork from data-original, not the placeholder', () => {
    const releases = parseBandcampGridReleases(
      page([
        gridItem({
          itemId: 'album-1',
          href: '/album/x',
          title: 'X',
          lazyImg: 'https://f4.bcbits.com/img/a9999999999_16.jpg',
        }),
      ])
    );
    expect(releases[0].artworkUrl).toBe('https://f4.bcbits.com/img/a9999999999_16.jpg');
  });

  it('returns null artwork rather than a data: placeholder or a fake URL', () => {
    const noImg = parseBandcampGridReleases(
      page([gridItem({ itemId: 'album-1', href: '/album/x', title: 'X', img: '' })])
    );
    expect(noImg[0].artworkUrl).toBeNull();
  });

  it('falls back to the URL path when data-item-id is absent', () => {
    const releases = parseBandcampGridReleases(
      page([
        gridItem({ href: '/album/no-id', title: 'No Id' }),
        gridItem({ href: '/track/no-id-track', title: 'No Id Track' }),
      ])
    );
    expect(releases.map(r => [r.externalId, r.type])).toEqual([
      [null, 'album'],
      [null, 'track'],
    ]);
  });

  it('skips items with no usable href or title', () => {
    const releases = parseBandcampGridReleases(
      page([
        `<li data-item-id="album-1" class="music-grid-item"><a href="/album/ok"><p class="title">Ok</p></a></li>`,
        `<li data-item-id="album-2" class="music-grid-item"><p class="title">No link</p></li>`,
        `<li data-item-id="album-3" class="music-grid-item"><a href="/album/untitled"></a></li>`,
      ])
    );
    expect(releases.map(r => r.title)).toEqual(['Ok']);
  });

  it('ignores grid entries that are neither album nor track', () => {
    const releases = parseBandcampGridReleases(
      page([
        gridItem({ itemId: 'album-1', href: '/album/real', title: 'Real' }),
        gridItem({ itemId: 'package-9', href: '/merch/t-shirt', title: 'T-Shirt' }),
      ])
    );
    expect(releases.map(r => r.title)).toEqual(['Real']);
  });

  it('deduplicates repeated items', () => {
    const dup = gridItem({ itemId: 'album-1', href: '/album/x', title: 'X' });
    expect(parseBandcampGridReleases(page([dup, dup]))).toHaveLength(1);
  });

  // A one-release artist gets a 303 to the release page, which has no grid — only a
  // #discography sidebar. Reading it is what stops such an artist being mistaken for a
  // parked squatter, so the catalog parser has to handle it too.
  it('falls back to the sidebar discography layout', () => {
    const sidebar = `<html><body>
      <div id="discography" class="sidebar">
        <ul>
          <li><div class="trackTitle"><a href="/album/subtitles-for-blushing">Subtitles For Blushing</a></div></li>
          <li><div class="trackTitle"><a href="/track/a-single">A Single</a></div></li>
        </ul>
      </div>
    </body></html>`;

    const releases = parseBandcampGridReleases(sidebar);
    expect(releases).toEqual([
      { externalId: null, type: 'album', href: '/album/subtitles-for-blushing', title: 'Subtitles For Blushing', artworkUrl: null },
      { externalId: null, type: 'track', href: '/track/a-single', title: 'A Single', artworkUrl: null },
    ]);
  });

  it('prefers the grid and does not also read the sidebar when both are present', () => {
    const both = `<html><body>
      <ol class="music-grid">${gridItem({ itemId: 'album-1', href: '/album/from-grid', title: 'From Grid' })}</ol>
      <div id="discography"><li><div class="trackTitle"><a href="/album/from-sidebar">From Sidebar</a></div></li></div>
    </body></html>`;
    expect(parseBandcampGridReleases(both).map(r => r.title)).toEqual(['From Grid']);
  });

  it('returns an empty array for a parked account with no releases', () => {
    expect(parseBandcampGridReleases('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });

  it('does not throw on malformed HTML', () => {
    expect(() => parseBandcampGridReleases('<html><ol class="music-grid"><li class="music-grid-item"')).not.toThrow();
    expect(() => parseBandcampGridReleases('')).not.toThrow();
  });
});

describe('existing Bandcamp parsers are unaffected', () => {
  // The new parser reads the same DOM; these guard against having changed shared behaviour.
  it('release counts still split album vs track', () => {
    expect(parseBandcampReleaseCounts(REAL_PAGE)).toEqual({ albums: 2, tracks: 1 });
  });

  it('release titles still return normalized match keys', () => {
    const titles = parseBandcampReleaseTitles(REAL_PAGE);
    expect(titles).toHaveLength(3);
    // Normalized for comparison: lowercase, punctuation and spacing stripped.
    expect(titles[1]).toBe('javelin');
  });
});
