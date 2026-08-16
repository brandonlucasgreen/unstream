import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockReadAllPages: vi.fn(),
  mockFindBandcampArtist: vi.fn(),
  mockFindSlugByBandcampUrl: vi.fn(),
  mockRequestCatalog: vi.fn(),
}));

vi.mock('../db', async importOriginal => {
  // artistSlug is the real one: the dedup here keys on it, and a stub would hide the case it
  // exists for — two spellings of one artist collapsing to a single lookup.
  const original = await importOriginal<typeof import('../db')>();
  return {
    artistSlug: original.artistSlug,
    getClient: () => ({ from: mocks.mockFrom }),
    readAllPages: mocks.mockReadAllPages,
    findArtistSlugByBandcampUrl: mocks.mockFindSlugByBandcampUrl,
  };
});
vi.mock('../../search/bandcamp-probe', () => ({ findBandcampArtist: mocks.mockFindBandcampArtist }));
vi.mock('../request-catalog', () => ({ requestArtistCatalog: mocks.mockRequestCatalog }));

import { linkCollectionItemsForArtist, resolveCollectionArtists } from '../collection-matching';

/** Rows handed to `readAllPages`, in the order the module asks for them. */
function pagedRows(...batches: Record<string, unknown>[][]) {
  let call = 0;
  mocks.mockReadAllPages.mockImplementation(() =>
    Promise.resolve({ ok: true, rows: batches[call++] ?? [] })
  );
}

interface LinkTables {
  releases?: { id: string; match_key: string | null }[];
}

/** Routes the reads and records every release_id write. */
function setupLinkDb({ releases = [] }: LinkTables) {
  const updates: { releaseId: unknown; itemIds: unknown }[] = [];

  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'releases') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: releases, error: null })),
          })),
        })),
      };
    }
    if (table === 'collection_items') {
      return {
        update: vi.fn((patch: { release_id: string }) => ({
          in: vi.fn((_column: string, itemIds: unknown) => {
            updates.push({ releaseId: patch.release_id, itemIds });
            return Promise.resolve({ error: null });
          }),
        })),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { updates };
}

describe('linkCollectionItemsForArtist', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('attaches a release to the items that were waiting for it', async () => {
    const { updates } = setupLinkDb({
      releases: [
        { id: 'rel-bias', match_key: 'bias' },
        { id: 'rel-other', match_key: 'someotherrecord' },
      ],
    });
    pagedRows([
      { id: 'item-1', title: 'Bias' },
      { id: 'item-2', title: 'bias' },
      { id: 'item-3', title: 'A Record We Have Never Catalogued' },
    ]);

    const linked = await linkCollectionItemsForArtist('artist-1', 'King Triumph');

    expect(linked).toBe(2);
    expect(updates).toEqual([{ releaseId: 'rel-bias', itemIds: ['item-1', 'item-2'] }]);
  });

  it('links nothing when the title only nearly matches', async () => {
    // A collection page says someone bought a specific record. "Bias (Deluxe)" is a different
    // record from "Bias" until something better than a title tells us otherwise, and a wrong
    // link here is a false claim about a person's purchase.
    const { updates } = setupLinkDb({ releases: [{ id: 'rel-bias', match_key: 'bias' }] });
    pagedRows([{ id: 'item-1', title: 'Bias (Deluxe Edition)' }]);

    expect(await linkCollectionItemsForArtist('artist-1', 'King Triumph')).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('matches titles that normalize away punctuation and accents', async () => {
    const { updates } = setupLinkDb({ releases: [{ id: 'rel-cl', match_key: 'carrielowell' }] });
    pagedRows([{ id: 'item-1', title: 'Carrie & Lowell' }]);

    expect(await linkCollectionItemsForArtist('artist-1', 'Sufjan Stevens')).toBe(1);
    expect(updates[0].releaseId).toBe('rel-cl');
  });

  it('matches a title with no Latin characters at all', async () => {
    // `releases.match_key` keeps any Unicode letter, so a Japanese title has a real key. The
    // import's original comparison stripped to [a-z0-9] and rendered it the empty string, which
    // could never equal that key — those albums silently never matched.
    const { updates } = setupLinkDb({ releases: [{ id: 'rel-jp', match_key: '東京' }] });
    pagedRows([{ id: 'item-1', title: '東京' }]);

    expect(await linkCollectionItemsForArtist('artist-1', 'Some Artist')).toBe(1);
    expect(updates[0].releaseId).toBe('rel-jp');
  });

  it('does nothing, and reads no items, when the artist has no releases yet', async () => {
    const { updates } = setupLinkDb({ releases: [] });

    expect(await linkCollectionItemsForArtist('artist-1', 'King Triumph')).toBe(0);
    expect(mocks.mockReadAllPages).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('reports zero rather than throwing when the release read fails', async () => {
    mocks.mockFrom.mockImplementation(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } })),
        })),
      })),
    }));

    // An artist's catalogue run must not fail because somebody's profile page missed a link.
    expect(await linkCollectionItemsForArtist('artist-1', 'King Triumph')).toBe(0);
  });
});

interface ResolveTables {
  /** slug -> the artists row that exists for it. */
  artists?: Record<string, { id: string; match_confidence: string | null }>;
}

function setupResolveDb({ artists = {} }: ResolveTables) {
  const artistUpserts: Record<string, unknown>[] = [];
  const linkUpserts: Record<string, unknown>[] = [];

  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'artists') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn((_column: string, slug: string) => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: artists[slug] ?? null, error: null })),
          })),
        })),
        upsert: vi.fn((row: Record<string, unknown>) => {
          artistUpserts.push(row);
          return {
            select: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: { id: `new-${row.slug}` }, error: null })),
            })),
          };
        }),
      };
    }
    if (table === 'artist_links') {
      return {
        upsert: vi.fn((row: Record<string, unknown>) => {
          linkUpserts.push(row);
          return Promise.resolve({ error: null });
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { artistUpserts, linkUpserts };
}

describe('resolveCollectionArtists', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mocks.mockFindSlugByBandcampUrl.mockResolvedValue(null);
    mocks.mockRequestCatalog.mockResolvedValue(true);
  });

  /** The pass paces itself between probes, so the timers have to be driven. */
  async function run(userId = 'user-1') {
    const pending = resolveCollectionArtists(userId);
    await vi.runAllTimersAsync();
    return pending;
  }

  it('stores an artist it can verify on Bandcamp and asks for their catalogue', async () => {
    const { artistUpserts, linkUpserts } = setupResolveDb({});
    pagedRows([{ artist_name: 'King Triumph' }, { artist_name: 'King Triumph' }]);
    mocks.mockFindBandcampArtist.mockResolvedValue({
      url: 'https://kingtriumph.bandcamp.com',
      bandName: 'King Triumph',
      location: null,
      releaseTitles: ['bias'],
      imageUrl: 'https://img/kt.jpg',
    });

    const summary = await run();

    expect(summary).toMatchObject({
      unlinkedItems: 2,
      artistNames: 1, // the same artist twice is one lookup
      created: 1,
      catalogRequested: 1,
    });
    expect(artistUpserts).toEqual([
      expect.objectContaining({
        slug: 'king-triumph',
        name: 'King Triumph',
        image_url: 'https://img/kt.jpg',
        // Not 'verified': the probe confirmed the account carries this name and holds releases,
        // which is not the release-level corroboration the search pipeline means by that word.
        match_confidence: 'unverified',
      }),
    ]);
    expect(linkUpserts).toEqual([
      expect.objectContaining({ platform: 'bandcamp', url: 'https://kingtriumph.bandcamp.com' }),
    ]);
    expect(mocks.mockRequestCatalog).toHaveBeenCalledWith(['new-king-triumph'], 'saved');
  });

  it('never probes for an artist it already holds', async () => {
    setupResolveDb({ artists: { 'sufjan-stevens': { id: 'artist-1', match_confidence: 'verified' } } });
    pagedRows([{ artist_name: 'Sufjan Stevens' }]);

    const summary = await run();

    expect(mocks.mockFindBandcampArtist).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ alreadyKnown: 1, created: 0 });
    // Still worth a catalogue: an artist can be stored and never crawled.
    expect(mocks.mockRequestCatalog).toHaveBeenCalledWith(['artist-1'], 'saved');
  });

  it('reuses the artist who already holds that Bandcamp URL under another spelling', async () => {
    const { artistUpserts } = setupResolveDb({
      artists: { bigthief: { id: 'artist-big', match_confidence: 'unverified' } },
    });
    pagedRows([{ artist_name: 'Big Thief' }]);
    mocks.mockFindBandcampArtist.mockResolvedValue({
      url: 'https://bigthief.bandcamp.com',
      bandName: 'Big Thief',
      location: null,
      releaseTitles: [],
      imageUrl: null,
    });
    mocks.mockFindSlugByBandcampUrl.mockResolvedValue('bigthief');

    const summary = await run();

    // A second row would split one artist's releases across two pages.
    expect(artistUpserts).toHaveLength(0);
    expect(summary).toMatchObject({ alreadyKnown: 1, created: 0 });
    expect(mocks.mockRequestCatalog).toHaveBeenCalledWith(['artist-big'], 'saved');
  });

  it('stores nothing when the probe cannot verify a Bandcamp page', async () => {
    const { artistUpserts } = setupResolveDb({});
    pagedRows([{ artist_name: 'Nobody We Can Find' }]);
    mocks.mockFindBandcampArtist.mockResolvedValue(null);

    const summary = await run();

    expect(artistUpserts).toHaveLength(0);
    expect(summary).toMatchObject({ notFound: 1, created: 0, catalogRequested: 0 });
    expect(mocks.mockRequestCatalog).not.toHaveBeenCalled();
  });

  it('refuses names on the non-artist and excluded lists without probing', async () => {
    const { artistUpserts } = setupResolveDb({});
    // 'Saturday Night Live' is on the non-artist list and 'Absurd' on the excluded one. Paying
    // for a record is a strong signal, but neither list is about signal strength: one keeps TV
    // shows and software from minting artist pages, the other is a deliberate exclusion.
    pagedRows([{ artist_name: 'Saturday Night Live' }, { artist_name: 'Absurd' }]);

    const summary = await run();

    expect(mocks.mockFindBandcampArtist).not.toHaveBeenCalled();
    expect(artistUpserts).toHaveLength(0);
    expect(summary).toMatchObject({ refused: 2 });
  });

  it('reports the names it did not get to instead of dropping them silently', async () => {
    setupResolveDb({});
    // 120 distinct artists, against a per-run ceiling of 100.
    pagedRows(Array.from({ length: 120 }, (_, i) => ({ artist_name: `Artist ${i}` })));
    mocks.mockFindBandcampArtist.mockResolvedValue(null);

    const summary = await run();

    expect(summary).toMatchObject({ artistNames: 120, deferred: 20 });
    expect(mocks.mockFindBandcampArtist).toHaveBeenCalledTimes(100);
  });

  it('asks for no more artists than one catalogue invocation accepts', async () => {
    // requestArtistCatalog slices anything longer than 25, so asking for more would silently
    // crawl a quarter of them. The rest are left to the scheduled sweep, which picks up any
    // artist holding a Bandcamp link.
    setupResolveDb({});
    pagedRows(Array.from({ length: 40 }, (_, i) => ({ artist_name: `Artist ${i}` })));
    mocks.mockFindBandcampArtist.mockImplementation((name: string) =>
      Promise.resolve({
        url: `https://${name.replace(/\W/g, '')}.bandcamp.com`,
        bandName: name,
        location: null,
        releaseTitles: [],
        imageUrl: null,
      })
    );

    const summary = await run();

    expect(summary).toMatchObject({ created: 40, catalogRequested: 25 });
    expect(mocks.mockRequestCatalog.mock.calls[0][0]).toHaveLength(25);
  });

  it('stops probing at its deadline and counts what is left as deferred', async () => {
    setupResolveDb({});
    pagedRows(Array.from({ length: 10 }, (_, i) => ({ artist_name: `Artist ${i}` })));
    // Each probe burns two minutes of fake time, so the six-minute deadline bites partway
    // through. Being killed at Netlify's ceiling instead would lose the summary entirely.
    mocks.mockFindBandcampArtist.mockImplementation(() => {
      vi.advanceTimersByTime(2 * 60_000);
      return Promise.resolve(null);
    });

    const summary = await run();

    expect(mocks.mockFindBandcampArtist.mock.calls.length).toBeLessThan(10);
    expect(summary.notFound + summary.deferred).toBe(10);
    expect(summary.deferred).toBeGreaterThan(0);
  });

  it('returns an empty summary when the unlinked-items read fails', async () => {
    setupResolveDb({});
    mocks.mockReadAllPages.mockResolvedValue({ ok: false, reason: 'PostgREST said no' });

    const summary = await run();

    expect(summary).toMatchObject({ unlinkedItems: 0, artistNames: 0, created: 0 });
    expect(mocks.mockFindBandcampArtist).not.toHaveBeenCalled();
  });
});
