// Parsing Mirlo's Fairplayer/Canimus federation catalog into release rows.
//
// The fixtures here are built from the documented response shape in Mirlo's API docs, not
// captured from a live response — Mirlo's robots.txt disallows `/v1/`, which is where the
// federation endpoint lives, so no request has been made pending Mirlo's own answer on that.
// What that means for these tests: they pin *our* decisions (host pinning, empty-title drafts,
// the 2925 date, opted-out artists) rather than certifying Mirlo's field names. The first live
// response is what confirms the shape, and `ingestCanimusCatalog` returning null on anything
// that isn't a Canimus root is what makes a shape mismatch loud instead of silent.

import { describe, it, expect } from 'vitest';
import {
  ingestCanimusCatalog,
  buildMirloReleases,
  mirloArtistSlug,
  type CanimusArtist,
} from '../release-ingest';

const CATALOG_URL = 'https://mirlo.space/v1/sm/canimus.json';
const NOW = new Date('2026-08-02T00:00:00Z');

function album(overrides: Record<string, unknown> = {}) {
  return {
    type: 'album',
    name: 'Garden Invicta',
    url: 'https://mirlo.space/m-corp/release/garden-invicta',
    release_date: '2024-01-15T00:00:00.000Z',
    license: 'CC BY-SA 4.0',
    artist: 'M Corp',
    images: { cover: { src: 'https://mirlo.space/img/cover.jpg', alt: null, width: 600, height: 600 } },
    description: 'About this album',
    children: [],
    ...overrides,
  };
}

function root(children: unknown[], deleted: unknown[] = []) {
  return { type: 'root', url: 'https://mirlo.space', children, deleted };
}

function artistNode(overrides: Record<string, unknown> = {}) {
  return {
    type: 'artist',
    name: 'M Corp',
    url: 'https://mirlo.space/m-corp',
    images: { cover: { src: 'https://mirlo.space/img/artist.jpg' } },
    summary: 'Short description',
    description: 'Full bio',
    links: [{ name: 'Bandcamp', href: 'https://mcorp.bandcamp.com', type: 'bandcamp' }],
    children: [album()],
    ...overrides,
  };
}

describe('ingestCanimusCatalog', () => {
  it('parses artists and their releases from a root document', () => {
    const catalog = ingestCanimusCatalog(root([artistNode()]), CATALOG_URL, NOW);

    expect(catalog).not.toBeNull();
    expect(catalog!.artists).toHaveLength(1);

    const artist = catalog!.artists[0];
    expect(artist.name).toBe('M Corp');
    expect(artist.slug).toBe('m-corp');
    expect(artist.releases).toHaveLength(1);
    expect(artist.releases[0]).toMatchObject({
      title: 'Garden Invicta',
      url: 'https://mirlo.space/m-corp/release/garden-invicta',
      releaseDate: '2024-01-15',
      datePrecision: 'day',
      status: 'released',
      artworkUrl: 'https://mirlo.space/img/cover.jpg',
    });
  });

  it('returns null — not an empty catalog — for a body that is not a Canimus root', () => {
    // A login wall, an error envelope or a challenge page must be distinguishable from
    // "nobody has opted in", or a bad response silently wipes every Mirlo artist.
    expect(ingestCanimusCatalog({ error: 'unauthorized' }, CATALOG_URL, NOW)).toBeNull();
    expect(ingestCanimusCatalog('<html>Just a moment…</html>', CATALOG_URL, NOW)).toBeNull();
    expect(ingestCanimusCatalog(null, CATALOG_URL, NOW)).toBeNull();
    expect(ingestCanimusCatalog(root([]), CATALOG_URL, NOW)).toEqual({ artists: [], deletedSlugs: [] });
  });

  it('drops a release whose url points at another host', () => {
    // A federation document exists to name other hosts, and release_sources.url is rendered as
    // a link a fan clicks. An off-host release URL is never attributed to the artist.
    const catalog = ingestCanimusCatalog(
      root([artistNode({ children: [album({ url: 'https://evil.example/m-corp/release/x' })] })]),
      CATALOG_URL,
      NOW
    );

    expect(catalog!.artists[0].releases).toHaveLength(0);
  });

  it('drops an artist whose url points at another host', () => {
    const catalog = ingestCanimusCatalog(
      root([artistNode({ url: 'https://evil.example/m-corp' })]),
      CATALOG_URL,
      NOW
    );

    expect(catalog!.artists).toHaveLength(0);
  });

  it('drops empty-title drafts rather than storing them as untitled', () => {
    const catalog = ingestCanimusCatalog(
      root([artistNode({ children: [album({ name: '   ' }), album({ name: 'Real Record' })] })]),
      CATALOG_URL,
      NOW
    );

    expect(catalog!.artists[0].releases.map(r => r.title)).toEqual(['Real Record']);
  });

  it('rejects the live 2925 date rather than sorting it to the top of every chronology', () => {
    // Mirlo genuinely carries a release dated 2925-11-02. Unbounded it lands in every
    // calendar subscriber's feed forever.
    const catalog = ingestCanimusCatalog(
      root([artistNode({ children: [album({ release_date: '2925-11-02T00:00:00.000Z' })] })]),
      CATALOG_URL,
      NOW
    );

    const release = catalog!.artists[0].releases[0];
    expect(release.releaseDate).toBeNull();
    expect(release.datePrecision).toBe('unknown');
    // Undated reads as released: promising a fan something is "coming" when we don't know is
    // the worse error.
    expect(release.status).toBe('released');
  });

  it('marks a genuine future date as announced', () => {
    const catalog = ingestCanimusCatalog(
      root([artistNode({ children: [album({ release_date: '2027-09-07T00:00:00.000Z' })] })]),
      CATALOG_URL,
      NOW
    );

    expect(catalog!.artists[0].releases[0]).toMatchObject({
      releaseDate: '2027-09-07',
      status: 'announced',
    });
  });

  it('refuses a non-http artwork src', () => {
    const catalog = ingestCanimusCatalog(
      root([artistNode({ children: [album({ images: { cover: { src: 'javascript:alert(1)' } } })] })]),
      CATALOG_URL,
      NOW
    );

    expect(catalog!.artists[0].releases[0].artworkUrl).toBeNull();
  });

  it('reads opted-out artists off the deleted array', () => {
    const catalog = ingestCanimusCatalog(
      root([artistNode()], [{ type: 'artist', name: 'Gone Artist', url: 'https://mirlo.space/gone-artist' }]),
      CATALOG_URL,
      NOW
    );

    expect(catalog!.deletedSlugs).toEqual(['gone-artist']);
  });

  it('keeps artist-declared off-host links, which are compared but never fetched', () => {
    const catalog = ingestCanimusCatalog(root([artistNode()]), CATALOG_URL, NOW);

    expect(catalog!.artists[0].links).toEqual([
      { type: 'bandcamp', href: 'https://mcorp.bandcamp.com' },
    ]);
  });

  it('ignores nodes that are not artists, and releases that are not albums', () => {
    const catalog = ingestCanimusCatalog(
      root([
        { type: 'playlist', name: 'Staff picks', url: 'https://mirlo.space/playlists/1' },
        artistNode({ children: [album(), { type: 'track', name: 'A Track', url: 'https://mirlo.space/x' }] }),
      ]),
      CATALOG_URL,
      NOW
    );

    expect(catalog!.artists).toHaveLength(1);
    expect(catalog!.artists[0].releases).toHaveLength(1);
  });
});

describe('buildMirloReleases', () => {
  const base: CanimusArtist = {
    name: 'M Corp',
    url: 'https://mirlo.space/m-corp',
    slug: 'm-corp',
    links: [],
    releases: [],
  };

  it('maps a release to a persistable row', () => {
    const [row] = buildMirloReleases({
      ...base,
      releases: [
        {
          title: 'Garden Invicta',
          url: 'https://mirlo.space/m-corp/release/garden-invicta',
          releaseDate: '2024-01-15',
          datePrecision: 'day',
          status: 'released',
          artworkUrl: 'https://mirlo.space/img/cover.jpg',
        },
      ],
    });

    expect(row).toMatchObject({
      title: 'Garden Invicta',
      slug: 'garden-invicta',
      matchKey: 'gardeninvicta',
      releaseDate: '2024-01-15',
      externalUrl: 'https://mirlo.space/m-corp/release/garden-invicta',
    });
  });

  it('infers type from the title, since Canimus types everything as album', () => {
    const rows = buildMirloReleases({
      ...base,
      releases: [
        { title: 'Some Record EP', url: 'https://mirlo.space/m-corp/release/a', releaseDate: null, datePrecision: 'unknown', status: 'released', artworkUrl: null },
        { title: 'Just A Record', url: 'https://mirlo.space/m-corp/release/b', releaseDate: null, datePrecision: 'unknown', status: 'released', artworkUrl: null },
      ],
    });

    expect(rows[0].releaseType).toBe('ep');
    // Not 'single' — a one-entry release is as likely to be a long-form piece, so 'other' is the
    // honest answer where a guess would be a claim.
    expect(rows[1].releaseType).toBe('other');
  });

  it('gives two same-slug titles distinct slugs within one artist', () => {
    const rows = buildMirloReleases({
      ...base,
      releases: [
        { title: 'Live!', url: 'https://mirlo.space/m-corp/release/live-1', releaseDate: null, datePrecision: 'unknown', status: 'released', artworkUrl: null },
        { title: 'Live?', url: 'https://mirlo.space/m-corp/release/live-2', releaseDate: null, datePrecision: 'unknown', status: 'released', artworkUrl: null },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].slug).not.toBe(rows[1].slug);
  });

  it('skips a title that normalizes to nothing', () => {
    const rows = buildMirloReleases({
      ...base,
      releases: [
        { title: '!!!', url: 'https://mirlo.space/m-corp/release/x', releaseDate: null, datePrecision: 'unknown', status: 'released', artworkUrl: null },
      ],
    });

    expect(rows).toHaveLength(0);
  });
});

describe('mirloArtistSlug', () => {
  it('accepts the three link shapes that appear in live data', () => {
    // Measured against the 66 stored mirlo artist_links: 50 bare, 15 with a second segment
    // (mostly /releases), and trailing slashes throughout.
    expect(mirloArtistSlug('https://mirlo.space/h220')).toBe('h220');
    expect(mirloArtistSlug('https://mirlo.space/sknob/')).toBe('sknob');
    expect(mirloArtistSlug('https://mirlo.space/helen-bell/releases')).toBe('helen-bell');
  });

  it('folds case so the catalog join is not case-sensitive', () => {
    expect(mirloArtistSlug('https://mirlo.space/M-Corp')).toBe('m-corp');
  });

  it('refuses a non-Mirlo host', () => {
    // A claimed artist can store any URL against the platform, so this is the check that stops
    // a mislabelled row joining against someone else's slug.
    expect(mirloArtistSlug('https://evil.example/m-corp')).toBeNull();
    expect(mirloArtistSlug('https://notmirlo.space/m-corp')).toBeNull();
  });

  it('refuses api and reserved paths, which are pages rather than artists', () => {
    expect(mirloArtistSlug('https://mirlo.space/v1/sm/canimus.json')).toBeNull();
    expect(mirloArtistSlug('https://mirlo.space/login')).toBeNull();
    expect(mirloArtistSlug('https://mirlo.space/')).toBeNull();
  });

  it('refuses a non-http scheme', () => {
    expect(mirloArtistSlug('javascript:alert(1)')).toBeNull();
    expect(mirloArtistSlug('not a url')).toBeNull();
  });
});
