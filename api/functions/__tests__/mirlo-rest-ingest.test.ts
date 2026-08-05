// Mirlo's REST API as a release source.
//
// **Every fixture here is real.** Each `trackGroups[]` entry below was captured from a live
// `GET https://api.mirlo.space/v1/artists/{slug}` on 2026-08-05 (209 releases across 31 artists,
// trimmed to the fields the ingest reads). That matters: the previous attempt at this integration
// built its fixtures from pasted documentation and therefore only ever pinned our own
// assumptions. These pin Mirlo's actual field names and actual data hygiene.
//
// The cases that would fail silently in production, and so are the point of this file:
//   - `null` minPrice read as free, which would advertise terms an artist never set
//   - cents read as currency units, publishing a $4.00 record as $400
//   - 'gbp' and 'GBP' stored as two different currencies
//   - drafts ingested as untitled releases, because they report isPublic: true
//   - an error body reduced to "this artist has released nothing"

import { describe, it, expect } from 'vitest';
import {
  buildMirloRelease,
  ingestMirloArtist,
  mirloArtistSlug,
  type MirloTrackGroupRaw,
} from '../release-ingest';

/** A fixed "now" so status and date-bounding assertions don't drift with the wall clock. */
const NOW = new Date('2026-08-05T12:00:00.000Z');

// --- Real captured releases ----------------------------------------------------

/** timerival — name-your-price: minPrice 0 with a suggestion, and a genuine future date. */
const NAME_YOUR_PRICE: MirloTrackGroupRaw = {
  title: 'Below the Apex of the Sky',
  urlSlug: 'below-the-apex-of-the-sky',
  type: null,
  releaseDate: '2026-09-04T00:00:00.000Z',
  minPrice: 0,
  currency: 'usd',
  isPreorder: false,
  isPublic: true,
  hideFromSearch: false,
  isGettable: true,
  deletedAt: null,
  cover: {
    sizes: {
      '600': 'https://cdn.mirlo.space/file/trackgroup-covers/1806e57e-11d5-4015-85c0-0cc6abaf96e7-x600.webp',
    },
  },
};

/** timerival — the one release in the whole sample with isPreorder: true. */
const PREORDER: MirloTrackGroupRaw = {
  title: 'Cooked',
  urlSlug: 'cooked',
  type: null,
  releaseDate: '2026-08-07T00:00:00.000Z',
  minPrice: 400,
  currency: 'usd',
  isPreorder: true,
  isPublic: true,
  hideFromSearch: false,
  isGettable: true,
  deletedAt: null,
  cover: {
    sizes: {
      '600': 'https://cdn.mirlo.space/file/trackgroup-covers/13022cc3-f02b-4ce8-a5d6-8f774b6165eb-x600.webp',
    },
  },
};

/** timerival — an ordinary priced, already-released record. */
const PLAIN_PRICED: MirloTrackGroupRaw = {
  title: 'stay safe out there',
  urlSlug: 'stay-safe-out-there',
  type: null,
  releaseDate: '2026-07-28T00:00:00.000Z',
  minPrice: 100,
  currency: 'usd',
  isPreorder: false,
  isPublic: true,
  hideFromSearch: false,
  isGettable: true,
  deletedAt: null,
  cover: { sizes: { '600': 'https://cdn.mirlo.space/file/trackgroup-covers/09f5c9d7-x600.webp' } },
};

/**
 * timerival — a draft. Note `isPublic: true`, `hideFromSearch: false`, `isGettable: true`: the
 * visibility flags do NOT mark it, which is exactly why the slug prefix is what's matched.
 */
const DRAFT_UUID_SLUG: MirloTrackGroupRaw = {
  title: '',
  urlSlug: 'mi-temp-slug-new-album-1a734faf-94c2-4a8e-9491-17906d3a0b3a',
  type: null,
  releaseDate: '2024-05-20T14:58:43.070Z',
  minPrice: null,
  currency: 'usd',
  isPreorder: false,
  isPublic: true,
  hideFromSearch: false,
  isGettable: true,
  deletedAt: null,
  cover: null,
};

/** botflymother — the other real draft shape: no uuid, just a counter. */
const DRAFT_COUNTER_SLUG: MirloTrackGroupRaw = {
  ...DRAFT_UUID_SLUG,
  urlSlug: 'mi-temp-slug-new-album-0',
  releaseDate: '2024-03-30T18:41:14.082Z',
};

/** mumbleandsigh — minPrice null alongside suggestedPrice null: no price configured. */
const NO_PRICE_SET: MirloTrackGroupRaw = {
  title: 'looptober 2025',
  urlSlug: 'looptober-2025',
  type: null,
  releaseDate: '2025-11-01T00:00:00.000Z',
  minPrice: null,
  currency: 'usd',
  isPreorder: false,
  isPublic: true,
  hideFromSearch: false,
  isGettable: true,
  deletedAt: null,
  cover: null,
};

/** dreamofomni — not purchasable, despite minPrice 0. A CD comp with no digital offer. */
const NOT_GETTABLE: MirloTrackGroupRaw = {
  title: ' [CD compilation] The Chosen Game Ones',
  urlSlug: 'cd-compilation-the-chosen-hardcore-ones',
  type: null,
  releaseDate: '2025-10-01T00:00:00.000Z',
  minPrice: 0,
  currency: 'cad',
  isPreorder: false,
  isPublic: true,
  hideFromSearch: false,
  isGettable: false,
  deletedAt: null,
  cover: null,
};

/** clive-murray — one of only 5 releases in 209 with `type` populated. */
const TYPED_LP: MirloTrackGroupRaw = {
  title: 'Earthman',
  urlSlug: 'earthman',
  type: 'lp',
  releaseDate: '2002-01-01T00:00:00.000Z',
  minPrice: 300,
  currency: 'GBP',
  isPreorder: false,
  isPublic: true,
  hideFromSearch: false,
  isGettable: true,
  deletedAt: null,
  cover: null,
};

/** jetjaguar — the other populated type value seen, plus a third currency casing. */
const TYPED_EP: MirloTrackGroupRaw = {
  title: 'Hoops',
  urlSlug: 'hoops',
  type: 'ep',
  releaseDate: '2023-05-05T00:00:00.000Z',
  minPrice: 100,
  currency: 'NZD',
  isPreorder: false,
  isPublic: true,
  hideFromSearch: false,
  isGettable: true,
  deletedAt: null,
  cover: null,
};

/** Wrap releases in the real `{ result: { urlSlug, trackGroups } }` envelope. */
function artistDoc(slug: string, trackGroups: MirloTrackGroupRaw[]): unknown {
  return { result: { urlSlug: slug, name: 'Test Artist', trackGroups } };
}

// --- Envelope and failure modes ------------------------------------------------

describe('ingestMirloArtist — what counts as an answer', () => {
  it('reads a real artist document', () => {
    const rows = ingestMirloArtist(artistDoc('timerival', [PLAIN_PRICED]), 'timerival', NOW);
    expect(rows).toHaveLength(1);
    expect(rows?.[0].title).toBe('stay safe out there');
  });

  it('distinguishes "no releases" from "not an answer" — the whole point', () => {
    // An artist who has genuinely released nothing: an empty list, which is a cacheable fact.
    expect(ingestMirloArtist(artistDoc('timerival', []), 'timerival', NOW)).toEqual([]);

    // Everything that is NOT an answer must be null, never []. An empty list here would be
    // recorded as an ordinary successful zero and reset the artist's cooldown for a week.
    expect(ingestMirloArtist(null, 'timerival', NOW)).toBeNull();
    expect(ingestMirloArtist('<html>challenge</html>', 'timerival', NOW)).toBeNull();
    expect(ingestMirloArtist({ error: 'Not found' }, 'timerival', NOW)).toBeNull();
    expect(ingestMirloArtist({ result: null }, 'timerival', NOW)).toBeNull();
    expect(ingestMirloArtist({ result: { urlSlug: 'timerival' } }, 'timerival', NOW)).toBeNull();
  });

  it('rejects the search endpoint’s plural `results` envelope', () => {
    // `/v1/artists?name=` returns { results: [...] } and embeds full artists. Accepting it here
    // would file a search hit's discography under whichever artist we were asking about.
    const searchShape = { results: [{ urlSlug: 'timerival', trackGroups: [PLAIN_PRICED] }] };
    expect(ingestMirloArtist(searchShape, 'timerival', NOW)).toBeNull();
  });

  it('rejects a document for a different artist', () => {
    // A redirect landing on someone else's profile would otherwise attribute their records here.
    const rows = ingestMirloArtist(artistDoc('someoneelse', [PLAIN_PRICED]), 'timerival', NOW);
    expect(rows).toBeNull();
  });

  it('matches the artist slug case-insensitively', () => {
    expect(ingestMirloArtist(artistDoc('TimeRival', [PLAIN_PRICED]), 'timerival', NOW)).toHaveLength(1);
  });
});

// --- Drafts and artist-set visibility ------------------------------------------

describe('ingestMirloArtist — what the artist has not published', () => {
  it('drops both real draft shapes, despite isPublic: true', () => {
    // Both real drafts in the 209-release sample. Note what they do NOT say: isPublic is true,
    // hideFromSearch is false, isGettable is true — the visibility flags mark neither of them.
    expect(DRAFT_UUID_SLUG.isPublic).toBe(true);
    expect(DRAFT_COUNTER_SLUG.hideFromSearch).toBe(false);

    const rows = ingestMirloArtist(
      artistDoc('timerival', [DRAFT_UUID_SLUG, DRAFT_COUNTER_SLUG, PLAIN_PRICED]),
      'timerival',
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows?.[0].title).toBe('stay safe out there');
  });

  it('drops a titled draft on its temp slug alone', () => {
    // In the sample the two draft signals were perfectly correlated: all 2 temp-slug releases had
    // an empty title and all 2 empty-title releases had a temp slug, so the test above would pass
    // on the title check by itself. This case is therefore **constructed, not observed** — a
    // draft the artist has begun titling but not published. It exists because the temp slug is
    // the durable "never published" marker of the two, and without this assertion the slug filter
    // would be untested code.
    const titledDraft: MirloTrackGroupRaw = {
      ...DRAFT_UUID_SLUG,
      title: 'Work In Progress',
    };
    expect(ingestMirloArtist(artistDoc('timerival', [titledDraft]), 'timerival', NOW)).toEqual([]);
  });

  it('respects isPublic, hideFromSearch and deletedAt', () => {
    // Uniform in the live sample, so these are guarded by construction rather than observation —
    // but the artist sets them deliberately and ingesting past them is a trust violation.
    const hidden: MirloTrackGroupRaw[] = [
      { ...PLAIN_PRICED, urlSlug: 'a', title: 'Private', isPublic: false },
      { ...PLAIN_PRICED, urlSlug: 'b', title: 'Unlisted', hideFromSearch: true },
      { ...PLAIN_PRICED, urlSlug: 'c', title: 'Deleted', deletedAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(ingestMirloArtist(artistDoc('timerival', hidden), 'timerival', NOW)).toEqual([]);
  });
});

// --- Prices: the three states --------------------------------------------------

describe('mirlo offers — cents, and null is not zero', () => {
  it('converts integer cents to currency units', () => {
    const [row] = ingestMirloArtist(artistDoc('timerival', [PREORDER]), 'timerival', NOW)!;
    // 400 cents is $4.00. Read as currency units it would publish this record at $400.
    expect(row.offers).toEqual([
      { format: 'digital', price: 4, currency: 'USD', availability: 'preorder' },
    ]);
  });

  it('treats minPrice 0 as name-your-price', () => {
    const [row] = ingestMirloArtist(artistDoc('timerival', [NAME_YOUR_PRICE]), 'timerival', NOW)!;
    expect(row.offers[0].price).toBe(0);
  });

  it('yields NO offer when no price is configured', () => {
    // 56 of 209 live releases. `price: 0` renders as "Name your price" — publishing that here
    // would advertise terms the artist never set.
    const [row] = ingestMirloArtist(artistDoc('mumbleandsigh', [NO_PRICE_SET]), 'mumbleandsigh', NOW)!;
    expect(row.offers).toEqual([]);
    expect(row.title).toBe('looptober 2025');
  });

  it('yields no offer when the release is not gettable, whatever the price says', () => {
    const [row] = ingestMirloArtist(artistDoc('dreamofomni', [NOT_GETTABLE]), 'dreamofomni', NOW)!;
    expect(NOT_GETTABLE.minPrice).toBe(0);
    expect(row.offers).toEqual([]);
  });

  it('normalizes inconsistent currency casing', () => {
    // Live sample carried 'usd' (100), 'GBP' (40), 'cad' (39), 'eur' (10), 'gbp' (8), 'NZD' (7),
    // 'USD' (5). Stored raw, GBP and gbp become two currencies for the same money.
    const lower = buildMirloRelease({ ...TYPED_LP, currency: 'gbp' }, 'a', new Set(), NOW);
    const upper = buildMirloRelease({ ...TYPED_LP, currency: 'GBP' }, 'a', new Set(), NOW);
    expect(lower?.offers[0].currency).toBe('GBP');
    expect(upper?.offers[0].currency).toBe('GBP');
    expect(lower?.offers[0].currency).toBe(upper?.offers[0].currency);
  });

  it('leaves currency null rather than guessing when it is absent', () => {
    // Not defaulted to USD: `formatMoney` renders a null currency as USD, so guessing here would
    // publish "£3.00" as "$3.00" — a wrong number about someone's money. A null currency is the
    // display layer's problem to handle, not the parser's to invent.
    const row = buildMirloRelease({ ...TYPED_LP, currency: null }, 'a', new Set(), NOW);
    expect(row?.offers[0].currency).toBeNull();
  });

  it('never emits a payout figure derived from platformPercent', () => {
    // platformPercent ran 7, 10, 15, 20, 25, 50 and 100 across the sample, contradicted the
    // artist-level defaultPlatformFee, and was 100 on a free release. Payout comes from the
    // platform registry; nothing here may smuggle this field into an offer.
    const withPercent = { ...PREORDER, platformPercent: 100 } as MirloTrackGroupRaw;
    const row = buildMirloRelease(withPercent, 'timerival', new Set(), NOW);
    expect(Object.keys(row!.offers[0]).sort()).toEqual(
      ['availability', 'currency', 'format', 'price'].sort()
    );
  });
});

// --- Type, status, dates, URLs -------------------------------------------------

describe('mirlo release mapping', () => {
  it('uses `type` when Mirlo populates it', () => {
    const lp = buildMirloRelease(TYPED_LP, 'clive-murray', new Set(), NOW);
    const ep = buildMirloRelease(TYPED_EP, 'jetjaguar', new Set(), NOW);
    expect(lp?.releaseType).toBe('album');
    expect(ep?.releaseType).toBe('ep');
  });

  it('infers type from the title when `type` is null', () => {
    // 204 of 209 live releases had type null, and Mirlo artists commonly bracket-prefix titles.
    const cases: [string, string][] = [
      ['[Single] The Trifecta', 'single'],
      ['[EP] Unclouded Future', 'ep'],
      ['[Compilation] 32-Bit Rekt', 'compilation'],
      ['Hometown Tour (Live at KW)', 'live'],
    ];
    for (const [title, expected] of cases) {
      const row = buildMirloRelease({ ...PLAIN_PRICED, title, type: null }, 'a', new Set(), NOW);
      expect(row?.releaseType, title).toBe(expected);
    }
  });

  it('marks a pre-order announced, and trusts the flag over the date', () => {
    const row = buildMirloRelease(PREORDER, 'timerival', new Set(), NOW);
    expect(row?.status).toBe('announced');
    expect(row?.offers[0].availability).toBe('preorder');

    // Flag wins even for a release whose date has already passed.
    const past = buildMirloRelease(
      { ...PREORDER, releaseDate: '2024-01-01T00:00:00.000Z' },
      'timerival',
      new Set(),
      NOW
    );
    expect(past?.status).toBe('announced');
  });

  it('marks a genuine future date announced without a pre-order flag', () => {
    // 2026-09-04 against a 2026-08-05 now. Mirlo really does carry dates this far out.
    const row = buildMirloRelease(NAME_YOUR_PRICE, 'timerival', new Set(), NOW);
    expect(row?.isPreorder).toBeUndefined();
    expect(row?.status).toBe('announced');
  });

  it('parses full ISO timestamps to a day-precision date', () => {
    const row = buildMirloRelease(PLAIN_PRICED, 'timerival', new Set(), NOW);
    expect(row?.releaseDate).toBe('2026-07-28');
    expect(row?.datePrecision).toBe('day');
  });

  it('bounds an implausible date instead of storing it', () => {
    // Mirlo has carried a release dated 2925-11-02. Unbounded, one typo sorts to the top of
    // every chronology and lands in every calendar feed forever.
    const row = buildMirloRelease(
      { ...PLAIN_PRICED, releaseDate: '2925-11-02T00:00:00.000Z' },
      'timerival',
      new Set(),
      NOW
    );
    expect(row?.releaseDate).toBeNull();
    expect(row?.datePrecision).toBe('unknown');
    // Undated still counts as released — promising a fan something is "coming" when we don't
    // know is the worse error.
    expect(row?.status).toBe('released');
  });

  it('builds the verified release URL shape', () => {
    const row = buildMirloRelease(PLAIN_PRICED, 'timerival', new Set(), NOW);
    // Verified live 2026-08-05: this URL returns 200.
    expect(row?.externalUrl).toBe('https://mirlo.space/timerival/release/stay-safe-out-there');
  });

  it('takes artwork from cover.sizes, not the opaque cover.url ids', () => {
    const row = buildMirloRelease(PREORDER, 'timerival', new Set(), NOW);
    expect(row?.artworkUrl).toBe(
      'https://cdn.mirlo.space/file/trackgroup-covers/13022cc3-f02b-4ce8-a5d6-8f774b6165eb-x600.webp'
    );

    // `cover.url` is an array of size-suffixed ids like "<uuid>-x600" — not URLs. Present but
    // without `sizes`, there is no usable artwork.
    const idsOnly = {
      ...PREORDER,
      cover: { url: ['13022cc3-original', '13022cc3-x600'] },
    } as MirloTrackGroupRaw;
    expect(buildMirloRelease(idsOnly, 'timerival', new Set(), NOW)?.artworkUrl).toBeNull();
  });

  it('gives two same-titled releases distinct slugs', () => {
    const rows = ingestMirloArtist(
      artistDoc('timerival', [
        { ...PLAIN_PRICED, urlSlug: 'one', title: 'Repeat' },
        { ...PLAIN_PRICED, urlSlug: 'two', title: 'Repeat' },
      ]),
      'timerival',
      NOW
    )!;
    expect(rows).toHaveLength(2);
    expect(rows[0].slug).not.toBe(rows[1].slug);
  });

  it('skips a release with no usable title or slug', () => {
    expect(buildMirloRelease({ ...PLAIN_PRICED, title: '   ' }, 'a', new Set(), NOW)).toBeNull();
    expect(buildMirloRelease({ ...PLAIN_PRICED, urlSlug: '' }, 'a', new Set(), NOW)).toBeNull();
  });
});

// --- Stored-link handling ------------------------------------------------------

describe('mirloArtistSlug', () => {
  it('handles every URL shape live artist_links actually holds', () => {
    // Measured 2026-08-02: 50 bare /{slug}, 15 with a second segment, 1 with three, trailing
    // slashes throughout.
    expect(mirloArtistSlug('https://mirlo.space/timerival')).toBe('timerival');
    expect(mirloArtistSlug('https://mirlo.space/timerival/')).toBe('timerival');
    expect(mirloArtistSlug('https://mirlo.space/timerival/releases')).toBe('timerival');
    expect(mirloArtistSlug('https://mirlo.space/timerival/release/cooked')).toBe('timerival');
    expect(mirloArtistSlug('https://www.mirlo.space/TimeRival')).toBe('timerival');
  });

  it('refuses anything that is not a Mirlo artist page', () => {
    // A claimed artist can save any URL against the platform, so the host is never assumed.
    expect(mirloArtistSlug('https://evil.example.com/timerival')).toBeNull();
    expect(mirloArtistSlug('https://mirlo.space.evil.com/timerival')).toBeNull();
    expect(mirloArtistSlug('javascript:alert(1)')).toBeNull();
    expect(mirloArtistSlug('https://mirlo.space/')).toBeNull();
    expect(mirloArtistSlug('not a url')).toBeNull();
  });

  it('refuses Mirlo’s own routes, which sit at artist depth', () => {
    for (const path of ['login', 'signup', 'pages', 'v1', 'admin', 'settings', 'checkout']) {
      expect(mirloArtistSlug(`https://mirlo.space/${path}`), path).toBeNull();
    }
  });
});
