// Tests for release-utils.
//
// Several of these are regressions for specific bugs in the abandoned first attempt at this
// feature (PR #336), which shipped zero tests. Each is labelled, because they look like
// trivia until you know they were real: a "hash" that was actually the first three bytes of
// the input, a normalizer that deleted every non-Latin title, and a slug map that clobbered
// within a single run.

import { describe, it, expect } from 'vitest';
import {
  releaseMatchKey,
  releaseSlug,
  shortHash,
  uniqueReleaseSlug,
  mapReleaseType,
  mapMusicBrainzReleaseType,
  isFuzzyReleaseMatch,
  releaseDatesDisagree,
  findExactReleaseMatch,
  findFuzzyReleaseMatch,
  parseReleaseDate,
  deriveStatus,
} from '../release-utils';

describe('releaseMatchKey', () => {
  it('folds accents so spellings agree', () => {
    expect(releaseMatchKey('Björk')).toBe(releaseMatchKey('Bjork'));
    expect(releaseMatchKey('Tanerélle')).toBe(releaseMatchKey('Tanerelle'));
    expect(releaseMatchKey('Sigur Rós')).toBe(releaseMatchKey('Sigur Ros'));
  });

  it('ignores case, spacing and punctuation', () => {
    expect(releaseMatchKey('Carrie & Lowell')).toBe(releaseMatchKey('carrie & lowell'));
    expect(releaseMatchKey('Album Name.')).toBe(releaseMatchKey('Album  Name'));
    expect(releaseMatchKey('Carrie & Lowell')).toBe('carrielowell');
  });

  // PR #336 regression: a bare [^a-z0-9] strip turned these into "" and the ingest then
  // did `if (!norm) continue`, so every CJK/Cyrillic/Greek title was silently dropped from
  // the catalog with no log line.
  it('does NOT collapse non-Latin titles to an empty string', () => {
    for (const title of ['東京', 'Привет', 'Ⅱ', 'こんにちは', '서울']) {
      expect(releaseMatchKey(title), `${title} should produce a key`).not.toBe('');
    }
  });

  it('keeps distinct non-Latin titles distinct', () => {
    expect(releaseMatchKey('東京')).not.toBe(releaseMatchKey('大阪'));
    expect(releaseMatchKey('Привет')).not.toBe(releaseMatchKey('Пока'));
  });

  // The over-merge trap: stripping to ASCII would reduce both of these to "tokyo" and
  // merge two different records. Under-merging is recoverable; a wrong merge is not.
  it('does not merge titles that differ only outside ASCII', () => {
    expect(releaseMatchKey('Tokyo 東京')).not.toBe(releaseMatchKey('Tokyo 大阪'));
  });

  it('returns empty only when there are genuinely no letters or numbers', () => {
    expect(releaseMatchKey('!!!???')).toBe('');
    expect(releaseMatchKey('')).toBe('');
  });
});

describe('shortHash', () => {
  // PR #336 regression. It used Buffer.from(title).toString('hex').slice(0, 6), which is
  // the first three bytes of the *input*, so all three of these collided — exactly the case
  // the comment said it existed to handle.
  it('distinguishes strings that share a long prefix', () => {
    const a = shortHash('Album Name.');
    const b = shortHash('Album Name!');
    const c = shortHash('Album Name?');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('is deterministic and fixed-width', () => {
    expect(shortHash('x')).toBe(shortHash('x'));
    expect(shortHash('a very much longer input string')).toHaveLength(8);
  });
});

describe('releaseSlug', () => {
  it('produces readable slugs', () => {
    expect(releaseSlug('Carrie & Lowell')).toBe('carrie-lowell');
    expect(releaseSlug('Hail To The Thief')).toBe('hail-to-the-thief');
    expect(releaseSlug('  Leading and trailing  ')).toBe('leading-and-trailing');
  });

  it('transliterates accents rather than dropping them', () => {
    expect(releaseSlug('Björk')).toBe('bjork');
    expect(releaseSlug('Sigur Rós - Takk...')).toBe('sigur-ros-takk');
  });

  // PR #336 regression: these produced "" and the release was then skipped entirely.
  it('never returns an empty slug for a titled release', () => {
    for (const title of ['東京', 'Привет', 'Ⅱ', '!!!']) {
      const slug = releaseSlug(title);
      expect(slug, `${title} produced an empty slug`).not.toBe('');
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('gives different non-Latin titles different slugs', () => {
    expect(releaseSlug('東京')).not.toBe(releaseSlug('大阪'));
  });

  it('caps length and leaves no trailing hyphen', () => {
    const slug = releaseSlug('A'.repeat(50) + ' ' + 'B'.repeat(60));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('uniqueReleaseSlug', () => {
  it('uses the plain slug when free', () => {
    expect(uniqueReleaseSlug('Carrie & Lowell', new Set())).toBe('carrie-lowell');
  });

  it('disambiguates on collision', () => {
    const taken = new Set(['album-name']);
    const slug = uniqueReleaseSlug('Album Name', taken);
    expect(slug).not.toBe('album-name');
    expect(slug.startsWith('album-name-')).toBe(true);
  });

  // PR #336 regression: the "already taken" set was read once per artist before the insert
  // loop and never updated, so two titles that slugified the same in one run both got the
  // bare slug and the second overwrote the first.
  it('keeps giving fresh slugs as the caller accumulates them', () => {
    const taken = new Set<string>();
    const slugs = ['Album Name.', 'Album Name!', 'Album Name?', 'Album Name'].map(t => {
      const s = uniqueReleaseSlug(t, taken);
      taken.add(s);
      return s;
    });
    expect(new Set(slugs).size).toBe(4);
  });

  it('resolves the identical-title case rather than returning a duplicate', () => {
    const taken = new Set<string>();
    const a = uniqueReleaseSlug('Same Title', taken); taken.add(a);
    const b = uniqueReleaseSlug('Same Title', taken); taken.add(b);
    const c = uniqueReleaseSlug('Same Title', taken);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('mapReleaseType', () => {
  it('passes through our own vocabulary', () => {
    for (const t of ['album', 'ep', 'single', 'compilation', 'live', 'remix', 'other'] as const) {
      expect(mapReleaseType(t)).toBe(t);
    }
  });

  it('is case and whitespace insensitive', () => {
    expect(mapReleaseType('  Album ')).toBe('album');
    expect(mapReleaseType('EP')).toBe('ep');
  });

  it('reads Bandcamp item-id prefixes', () => {
    expect(mapReleaseType('album-1891263657')).toBe('album');
    expect(mapReleaseType('track-456')).toBe('single');
    expect(mapReleaseType('track')).toBe('single');
  });

  // PR #336 regression: its mapper collapsed everything to album-or-single and could never
  // emit 'ep' or 'compilation'. Type is the strongest dedup signal we have for artists with
  // no shared identifier, so losing it is expensive.
  it('can actually emit every granular type', () => {
    expect(mapReleaseType('mini-album')).toBe('ep');
    expect(mapReleaseType('Compilation Album')).toBe('compilation');
    expect(mapReleaseType('Live Album')).toBe('live');
    expect(mapReleaseType('Remixes')).toBe('remix');
  });

  it('falls back to other rather than guessing album', () => {
    expect(mapReleaseType('mixtape')).toBe('other');
    expect(mapReleaseType('')).toBe('other');
    expect(mapReleaseType(null)).toBe('other');
    expect(mapReleaseType(undefined)).toBe('other');
  });
});

describe('parseReleaseDate', () => {
  const now = new Date('2026-07-31T00:00:00Z');

  it('accepts ISO dates', () => {
    expect(parseReleaseDate('2025-05-30', now)).toEqual({ date: '2025-05-30', precision: 'day' });
  });

  it('accepts the textual formats Bandcamp uses', () => {
    expect(parseReleaseDate('December 6, 2024', now)).toEqual({ date: '2024-12-06', precision: 'day' });
    expect(parseReleaseDate('Dec 6, 2024', now)).toEqual({ date: '2024-12-06', precision: 'day' });
    expect(parseReleaseDate('30 May 2025 00:00:00 GMT', now)).toEqual({ date: '2025-05-30', precision: 'day' });
  });

  // A date-only string through `new Date(s)` parses as local midnight and can format back
  // as the previous day. Netlify runs UTC so functions were safe, but a migration or script
  // run from a laptop was not.
  it('does not shift the day by timezone', () => {
    expect(parseReleaseDate('December 6, 2024', now).date).toBe('2024-12-06');
    expect(parseReleaseDate('2024-12-06', now).date).toBe('2024-12-06');
  });

  it('records partial precision instead of inventing a day', () => {
    expect(parseReleaseDate('2024-12', now)).toEqual({ date: '2024-12-01', precision: 'month' });
    expect(parseReleaseDate('2024', now)).toEqual({ date: '2024-01-01', precision: 'year' });
  });

  // This is live data, not a hypothetical: Mirlo carries a release dated 2925-11-02.
  // Unbounded it sorts to the top of every chronology and lands in every ICS subscriber's
  // calendar permanently.
  it('rejects the typo years that are actually in upstream data', () => {
    expect(parseReleaseDate('2925-11-02', now)).toEqual({ date: null, precision: 'unknown' });
    expect(parseReleaseDate('0202-01-01', now)).toEqual({ date: null, precision: 'unknown' });
    expect(parseReleaseDate('1899-12-31', now)).toEqual({ date: null, precision: 'unknown' });
  });

  it('keeps genuine future announcements', () => {
    // Mirlo really does schedule this far out — verified live.
    expect(parseReleaseDate('2027-09-07', now).date).toBe('2027-09-07');
    expect(parseReleaseDate('2026-10-10', now).date).toBe('2026-10-10');
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(parseReleaseDate('2024-02-31', now).date).toBeNull();
    expect(parseReleaseDate('2024-13-01', now).date).toBeNull();
  });

  it('treats missing and unparseable input as unknown, not as a date', () => {
    for (const input of [null, undefined, '', '   ', 'sometime last year', 'TBA']) {
      expect(parseReleaseDate(input, now)).toEqual({ date: null, precision: 'unknown' });
    }
  });
});

describe('deriveStatus', () => {
  const now = new Date('2026-07-31T12:00:00Z');

  it('marks future dates as announced', () => {
    expect(deriveStatus('2027-09-07', false, now)).toBe('announced');
    expect(deriveStatus('2026-08-01', false, now)).toBe('announced');
  });

  it('marks past and same-day dates as released', () => {
    expect(deriveStatus('2025-01-01', false, now)).toBe('released');
    expect(deriveStatus('2026-07-31', false, now)).toBe('released');
  });

  it('trusts an upstream pre-order flag over the date', () => {
    // Bandcamp and Mirlo both expose this, and it's more reliable than a possibly
    // imprecise date.
    expect(deriveStatus('2020-01-01', true, now)).toBe('announced');
  });

  it('treats an undated release as released rather than coming soon', () => {
    // Undated releases are overwhelmingly back-catalog; telling a fan something is coming
    // when we don't know is the worse error.
    expect(deriveStatus(null, false, now)).toBe('released');
  });
});

describe('mapMusicBrainzReleaseType', () => {
  it('maps primary types directly', () => {
    expect(mapMusicBrainzReleaseType('Album', [])).toBe('album');
    expect(mapMusicBrainzReleaseType('EP', [])).toBe('ep');
    expect(mapMusicBrainzReleaseType('Single', [])).toBe('single');
  });

  it('is case-insensitive', () => {
    expect(mapMusicBrainzReleaseType('album', [])).toBe('album');
  });

  it('lets a secondary type override the primary one', () => {
    // A live album is more usefully typed 'live' than 'album' for dedup — the same
    // granularity-over-collapsing philosophy mapReleaseType already applies to Bandcamp.
    expect(mapMusicBrainzReleaseType('Album', ['Live'])).toBe('live');
    expect(mapMusicBrainzReleaseType('Album', ['Compilation'])).toBe('compilation');
    expect(mapMusicBrainzReleaseType('Album', ['Remix'])).toBe('remix');
  });

  it('falls back to other for unrecognized or missing primary types', () => {
    expect(mapMusicBrainzReleaseType('Broadcast', [])).toBe('other');
    expect(mapMusicBrainzReleaseType(null, null)).toBe('other');
    expect(mapMusicBrainzReleaseType(undefined, undefined)).toBe('other');
  });
});

describe('isFuzzyReleaseMatch', () => {
  it('flags one key as a probable variant of a longer one containing it', () => {
    expect(isFuzzyReleaseMatch('carrielowell', 'carrielowelldeluxeedition')).toBe(true);
  });

  it('is symmetric', () => {
    expect(isFuzzyReleaseMatch('carrielowelldeluxeedition', 'carrielowell')).toBe(true);
  });

  it('never flags an exact match — that is tier 2, not tier 3', () => {
    expect(isFuzzyReleaseMatch('carrielowell', 'carrielowell')).toBe(false);
  });

  it('does not flag titles that are simply different, even if similar in length', () => {
    expect(isFuzzyReleaseMatch('redalbum', 'bluealbum')).toBe(false);
  });

  it('requires the shorter key to be a real substring, not just similar', () => {
    expect(isFuzzyReleaseMatch('carrieandlowell', 'lowellandcarrie')).toBe(false);
  });

  it('ignores very short keys to avoid coincidental containment', () => {
    expect(isFuzzyReleaseMatch('ep', 'thebigeprelease')).toBe(false);
  });

  it('requires the shorter key to cover most of the longer one, not just any amount', () => {
    // "album" is contained in a much longer, unrelated title — containment alone isn't
    // enough evidence without a length-ratio floor.
    expect(isFuzzyReleaseMatch('album', 'thecompletealbumcollectionboxsetwithbonusdisc')).toBe(false);
  });
});

// Every case below is drawn from a real row pair in the production catalog, sampled
// 2026-08-29. The counts in the comments are measurements, not estimates.

describe('releaseDatesDisagree', () => {
  it('compares only as far as the coarser precision vouches for', () => {
    // Discogs gives the bare year 2020 as "2020-01-01"; Bandcamp gives the day. Comparing
    // those as full dates would call every such pair different, which is the opposite of true.
    expect(releaseDatesDisagree(
      { date: '2020-08-21', precision: 'day' },
      { date: '2020-01-01', precision: 'year' }
    )).toBe(false);

    expect(releaseDatesDisagree(
      { date: '2020-03-15', precision: 'day' },
      { date: '2019-01-01', precision: 'year' }
    )).toBe(true);
  });

  it('treats a missing date as no evidence, never as disagreement', () => {
    expect(releaseDatesDisagree({ date: null, precision: 'day' }, { date: '2020-01-01', precision: 'day' })).toBe(false);
    expect(releaseDatesDisagree({ date: '2020-01-01', precision: 'day' }, { date: undefined, precision: null })).toBe(false);
    expect(releaseDatesDisagree({ date: '2020-01-01', precision: 'unknown' }, { date: '1999-01-01', precision: 'day' })).toBe(false);
  });

  it('separates two day-precision releases a month apart', () => {
    expect(releaseDatesDisagree(
      { date: '2023-02-02', precision: 'day' },
      { date: '2022-02-04', precision: 'day' }
    )).toBe(true);
  });

  it('agrees to the month when that is all both sides claim', () => {
    expect(releaseDatesDisagree(
      { date: '2021-06-01', precision: 'month' },
      { date: '2021-06-25', precision: 'day' }
    )).toBe(false);
  });
});

describe('findExactReleaseMatch', () => {
  const javelinFromDiscogs = { match_key: 'javelin', release_type: 'other', release_date: '2023-10-06', date_precision: 'day' };

  it('matches across release types — the 931-pair Discogs blind spot', () => {
    // Discogs' artist listing has no type field for a master, so 92% of Discogs rows are
    // typed 'other' while the same record arrives from Bandcamp as 'album'. Keyed on
    // (release_type, match_key), those two could never meet.
    expect(findExactReleaseMatch([javelinFromDiscogs], {
      matchKey: 'javelin',
      releaseDate: '2023-10-06',
      datePrecision: 'day',
    })).toBe(javelinFromDiscogs);
  });

  it('still matches when the two types are both meaningful and differ', () => {
    // "Live At The Echo", filed 'live' by one source and 'album' by the other, same day.
    const live = { match_key: 'liveattheecho', release_type: 'live', release_date: '2022-04-01', date_precision: 'day' };
    expect(findExactReleaseMatch([live], {
      matchKey: 'liveattheecho',
      releaseDate: '2022-04-01',
      datePrecision: 'day',
    })).toBe(live);
  });

  it('refuses a same-title match when the dates positively disagree', () => {
    // An artist's single "Home" and their album "Home" are two records, and the date is the
    // only thing that says so once type is out of the identity test.
    expect(findExactReleaseMatch([javelinFromDiscogs], {
      matchKey: 'javelin',
      releaseDate: '2019-04-02',
      datePrecision: 'day',
    })).toBeNull();
  });

  it('matches on the title alone when neither side has a date', () => {
    const faircamp = { match_key: 'misalignment', release_type: 'album' };
    expect(findExactReleaseMatch([faircamp], { matchKey: 'misalignment' })).toBe(faircamp);
  });
});

describe('findFuzzyReleaseMatch', () => {
  it('flags a containment match when nothing rules it out', () => {
    const carrie = { match_key: 'carrielowell', release_type: 'album', release_date: null, date_precision: null };
    expect(findFuzzyReleaseMatch([carrie], { matchKey: 'carrielowelldeluxeedition' })).toBe(carrie);
  });

  it('drops the flag when day-precision dates disagree — 687 of 858 catalog pairs', () => {
    // "Acid Dub Versions III" (2025) against "II" (2023): a containment match between titles
    // is a guess, two sources reporting different days is a fact, and the fact wins.
    const two = { match_key: 'aciddubversionsii', release_type: 'other', release_date: '2023-09-22', date_precision: 'day' };
    expect(findFuzzyReleaseMatch([two], {
      matchKey: 'aciddubversionsiii',
      releaseDate: '2025-11-28',
      datePrecision: 'day',
    })).toBeNull();
  });

  it('keeps the flag when the same-titled pair shares a date', () => {
    // "32-Bit Rekt Trilogy" on Jam.coop against "[Compilation] 32-Bit Rekt Trilogy" on Mirlo,
    // both 2022-12-11 — a real duplicate, and one a human should still confirm.
    const jamcoop = { match_key: '32bitrekttrilogy', release_type: 'other', release_date: '2022-12-11', date_precision: 'day' };
    expect(findFuzzyReleaseMatch([jamcoop], {
      matchKey: 'compilation32bitrekttrilogy',
      releaseDate: '2022-12-11',
      datePrecision: 'day',
    })).toBe(jamcoop);
  });
});
