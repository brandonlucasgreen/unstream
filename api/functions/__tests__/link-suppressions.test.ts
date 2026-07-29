// Admin link suppressions: removing one wrong platform link from a result
// without removing the artist.

import { describe, it, expect } from 'vitest';
import {
  applyLinkSuppressions,
  isUrlSuppressed,
  normalizeUrlForMatch,
  urlMatchPrefilter,
  filterAndSort,
  type LinkSuppression,
} from '../search-utils';

type Result = Parameters<typeof applyLinkSuppressions>[0][number];

function artist(name: string, platforms: { sourceId: string; url: string }[], imageUrl?: string): Result {
  return {
    id: `test-${name}`,
    name,
    type: 'artist',
    imageUrl,
    platforms: platforms as Result['platforms'],
    matchConfidence: 'verified',
  } as Result;
}

describe('normalizeUrlForMatch', () => {
  it('ignores case and trailing slashes', () => {
    expect(normalizeUrlForMatch('https://TaylorSwift.Bandcamp.com/'))
      .toBe(normalizeUrlForMatch('https://taylorswift.bandcamp.com'));
  });

  // The same page arrives as http from older stored rows and some MusicBrainz
  // relations, and www-prefixed from official-site scrapes. A suppression saved
  // from one spelling has to match the others.
  it('ignores the scheme', () => {
    expect(normalizeUrlForMatch('http://taylorswift.bandcamp.com'))
      .toBe(normalizeUrlForMatch('https://taylorswift.bandcamp.com'));
  });

  it('ignores a leading www.', () => {
    expect(normalizeUrlForMatch('https://www.discogs.com/artist/1024240'))
      .toBe(normalizeUrlForMatch('https://discogs.com/artist/1024240'));
  });

  it('does not conflate different paths', () => {
    expect(normalizeUrlForMatch('https://x.bandcamp.com/music'))
      .not.toBe(normalizeUrlForMatch('https://x.bandcamp.com'));
  });

  it('keeps the query string, which is what distinguishes search links', () => {
    expect(normalizeUrlForMatch('https://duckduckgo.com/?q=site:ko-fi.com+a'))
      .not.toBe(normalizeUrlForMatch('https://duckduckgo.com/?q=site:ko-fi.com+b'));
  });

  it('does not treat a lookalike host as the same page', () => {
    expect(normalizeUrlForMatch('https://bandcamp.com.evil.test/x'))
      .not.toBe(normalizeUrlForMatch('https://bandcamp.com/x'));
  });

  it('falls back to a plain key for an unparseable URL', () => {
    expect(normalizeUrlForMatch('  Not A Url/ ')).toBe('not a url');
  });
});

describe('urlMatchPrefilter', () => {
  it('drops the query so one SQL pattern covers every spelling', () => {
    expect(urlMatchPrefilter('http://WWW.Discogs.com/artist/1024240/?foo=1'))
      .toBe('discogs.com/artist/1024240');
  });
});

describe('isUrlSuppressed', () => {
  const perArtist: LinkSuppression[] = [
    { url: 'https://taylorswift.bandcamp.com', artist_name_norm: 'taylorswift' },
  ];

  it('matches the scoped artist regardless of URL casing or trailing slash', () => {
    expect(isUrlSuppressed('https://taylorswift.bandcamp.com/', 'Taylor Swift', perArtist)).toBe(true);
  });

  it('matches when a later source hands back the same page over http', () => {
    expect(isUrlSuppressed('http://taylorswift.bandcamp.com', 'Taylor Swift', perArtist)).toBe(true);
  });

  it('leaves the same URL alone for a different artist', () => {
    expect(isUrlSuppressed('https://taylorswift.bandcamp.com', 'Taylor Swift Tribute', perArtist)).toBe(false);
  });

  it('matches every artist when the scope is global', () => {
    const global: LinkSuppression[] = [
      { url: 'https://buymeacoffee.com/impostor', artist_name_norm: null },
    ];
    expect(isUrlSuppressed('https://buymeacoffee.com/impostor', 'Anyone At All', global)).toBe(true);
  });

  it('returns false with no suppressions', () => {
    expect(isUrlSuppressed('https://x.bandcamp.com', 'X', [])).toBe(false);
  });
});

describe('applyLinkSuppressions', () => {
  it('removes only the suppressed link and keeps the artist', () => {
    const results = [
      artist('Taylor Swift', [
        { sourceId: 'bandcamp', url: 'https://taylorswift.bandcamp.com' },
        { sourceId: 'discogs', url: 'https://www.discogs.com/artist/1024240' },
      ]),
    ];

    applyLinkSuppressions(results, [
      { url: 'https://taylorswift.bandcamp.com', artist_name_norm: 'taylorswift' },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].platforms.map(p => p.sourceId)).toEqual(['discogs']);
  });

  it('does not touch a homonym artist who owns the same URL', () => {
    const results = [
      artist('Abhorrence', [{ sourceId: 'bandcamp', url: 'https://abhorrence.bandcamp.com' }]),
      artist('Abhorrence FIN', [{ sourceId: 'bandcamp', url: 'https://abhorrence.bandcamp.com' }]),
    ];

    applyLinkSuppressions(results, [
      { url: 'https://abhorrence.bandcamp.com', artist_name_norm: 'abhorrencefin' },
    ]);

    expect(results[0].platforms).toHaveLength(1);
    expect(results[1].platforms).toHaveLength(0);
  });

  it('clears a Bandcamp-sourced photo when the Bandcamp link goes', () => {
    const results = [
      artist(
        'Taylor Swift',
        [{ sourceId: 'bandcamp', url: 'https://taylorswift.bandcamp.com' }],
        'https://f4.bcbits.com/img/0012345678_10.jpg',
      ),
    ];

    applyLinkSuppressions(results, [
      { url: 'https://taylorswift.bandcamp.com', artist_name_norm: 'taylorswift' },
    ]);

    expect(results[0].imageUrl).toBeUndefined();
  });

  it('leaves a photo from another source in place', () => {
    const results = [
      artist(
        'Taylor Swift',
        [{ sourceId: 'bandcamp', url: 'https://taylorswift.bandcamp.com' }],
        'https://mirlo.space/img/artist.jpg',
      ),
    ];

    applyLinkSuppressions(results, [
      { url: 'https://taylorswift.bandcamp.com', artist_name_norm: 'taylorswift' },
    ]);

    expect(results[0].imageUrl).toBe('https://mirlo.space/img/artist.jpg');
  });

  it('is a no-op with an empty suppression list', () => {
    const results = [artist('X', [{ sourceId: 'bandcamp', url: 'https://x.bandcamp.com' }])];
    applyLinkSuppressions(results, []);
    expect(results[0].platforms).toHaveLength(1);
  });

  it('leaves a result with nothing but search links to be dropped by filterAndSort', () => {
    const results = [
      artist('Taylor Swift', [
        { sourceId: 'bandcamp', url: 'https://taylorswift.bandcamp.com' },
        { sourceId: 'buymeacoffee', url: 'https://buymeacoffee.com/explore-creators' },
      ]),
    ];

    applyLinkSuppressions(results, [
      { url: 'https://taylorswift.bandcamp.com', artist_name_norm: 'taylorswift' },
    ]);

    expect(filterAndSort(results, 'taylor swift')).toHaveLength(0);
  });
});
