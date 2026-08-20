import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockReadAllPages: vi.fn(),
  mockFetchAllAlbums: vi.fn(),
  mockResolveArtists: vi.fn(),
}));

vi.mock('../db', () => ({
  getClient: () => ({ from: mocks.mockFrom }),
  readAllPages: mocks.mockReadAllPages,
}));
// Stubbed so these tests stay about the import. The pass it replaces probes Bandcamp for every
// unknown artist name; left real against this file's mocked `../db` it would throw, and the
// handler catches that on purpose, so the whole suite would go on passing while the pass did
// nothing. Its own behaviour is covered in collection-matching.test.ts.
vi.mock('../collection-matching', () => ({
  resolveCollectionArtists: mocks.mockResolveArtists,
}));
vi.mock('../bandcamp-subsonic', async importOriginal => {
  const original = await importOriginal<typeof import('../bandcamp-subsonic')>();
  return { ...original, subsonicFetchAllAlbums: mocks.mockFetchAllAlbums };
});

import { handler } from '../bandcamp-sync-background';
import { SubsonicError } from '../bandcamp-subsonic';
import { encryptCredential } from '../credential-crypto';

function internalEvent(body: unknown) {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer internal-secret' },
    body: JSON.stringify(body),
  };
}

interface TableMocks {
  connectionRow?: Record<string, unknown> | null;
  releases?: Record<string, unknown>[];
  savedRows?: Record<string, unknown>[];
}

// Routes supabase table calls; records connection updates, item upserts, and
// saved_artists writes (the auto-mark-supported side effect).
function setupDb({ connectionRow = null, releases = [], savedRows = [] }: TableMocks) {
  const connectionUpdates: Record<string, unknown>[] = [];
  const upsertBatches: Record<string, unknown>[][] = [];
  const savedInserts: Record<string, unknown>[][] = [];
  const savedUpdates: { patch: Record<string, unknown>; column: string; values: unknown }[] = [];

  mocks.mockFrom.mockImplementation((table: string) => {
    if (table === 'bandcamp_connections') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: connectionRow, error: null })),
          })),
        })),
        update: vi.fn((patch: Record<string, unknown>) => {
          connectionUpdates.push(patch);
          return { eq: vi.fn(() => Promise.resolve({ error: null })) };
        }),
      };
    }
    if (table === 'collection_items') {
      return {
        upsert: vi.fn((rows: Record<string, unknown>[]) => {
          upsertBatches.push(rows);
          return Promise.resolve({ error: null });
        }),
      };
    }
    if (table === 'releases') {
      return {
        select: vi.fn(() => ({
          in: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: releases, error: null })),
          })),
        })),
      };
    }
    if (table === 'saved_artists') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            // Honours the column actually queried. Without this the mock answers the
            // artist_id read and the artist_slug read identically, and a row filed under a
            // synthetic slug would look findable by slug when in production it isn't — the
            // exact blindness the dedup fix exists to close.
            in: vi.fn((column: string, values: unknown[]) =>
              Promise.resolve({
                data: savedRows.filter(row => values.includes(row[column])),
                error: null,
              })
            ),
          })),
        })),
        upsert: vi.fn((rows: Record<string, unknown>[]) => {
          savedInserts.push(rows);
          return Promise.resolve({ error: null });
        }),
        update: vi.fn((patch: Record<string, unknown>) => ({
          eq: vi.fn(() => ({
            in: vi.fn((column: string, values: unknown) => {
              savedUpdates.push({ patch, column, values });
              return Promise.resolve({ error: null });
            }),
          })),
        })),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { connectionUpdates, upsertBatches, savedInserts, savedUpdates };
}

const SUFJAN = { id: 'artist-1', slug: 'sufjan-stevens', name: 'Sufjan Stevens', image_url: 'https://img/s.jpg' };

describe('bandcamp-sync-background handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.INTERNAL_FUNCTION_SECRET = 'internal-secret';
    process.env.BANDCAMP_CREDENTIAL_KEY = randomBytes(32).toString('base64');
    mocks.mockReadAllPages.mockResolvedValue({ ok: true, rows: [] });
    mocks.mockResolveArtists.mockResolvedValue({ created: 0, catalogRequested: 0 });
  });

  afterEach(() => {
    delete process.env.INTERNAL_FUNCTION_SECRET;
    delete process.env.BANDCAMP_CREDENTIAL_KEY;
  });

  it('refuses requests without the internal secret', async () => {
    const res = await handler({
      httpMethod: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: JSON.stringify({ userId: 'user-1' }),
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.mockFrom).not.toHaveBeenCalled();
  });

  it('skips quietly when the user disconnected before the run', async () => {
    setupDb({ connectionRow: null });
    const res = await handler(internalEvent({ userId: 'user-1' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ skipped: true });
  });

  it('imports albums as purchased items and completes the connection row', async () => {
    const ciphertext = encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const { connectionUpdates, upsertBatches } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext },
    });
    mocks.mockFetchAllAlbums.mockResolvedValue([
      { id: 'al-1', name: 'Illinois', artist: 'Sufjan Stevens', created: '2026-01-01T00:00:00Z' },
      { id: 'al-2', name: 'Carrie & Lowell', artist: 'Sufjan Stevens' },
      { id: 'al-1', name: 'Illinois', artist: 'Sufjan Stevens' }, // duplicate id from source
    ]);

    const res = await handler(internalEvent({ userId: 'user-1' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ imported: 2 });

    // The credential was decrypted and used.
    expect(mocks.mockFetchAllAlbums).toHaveBeenCalledWith({ username: 'fan', t: 'tok', s: 'salt' });

    // Deduplicated rows, all purchased, never touching `hidden`.
    const rows = upsertBatches.flat();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ user_id: 'user-1', source: 'bandcamp', provenance: 'purchased' });
      expect(row).not.toHaveProperty('hidden');
    }
    expect(rows[0]).toMatchObject({ external_id: 'al-1', title: 'Illinois', acquired_at: '2026-01-01T00:00:00Z' });

    // Success recorded: idle, count, timestamp, no lingering error.
    const done = connectionUpdates.at(-1)!;
    expect(done).toMatchObject({ sync_status: 'idle', sync_error: null, item_count: 2 });
    expect(done.last_synced_at).toBeTruthy();
  });

  it('matches releases by normalized artist name + title, skipping ambiguous artists', async () => {
    const ciphertext = encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const { upsertBatches } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext },
      releases: [
        { id: 'rel-1', artist_id: 'artist-1', match_key: 'illinois', artwork_url: 'https://f4.bcbits.com/a.jpg' },
      ],
    });
    mocks.mockReadAllPages.mockResolvedValue({
      ok: true,
      rows: [
        SUFJAN,
        { id: 'artist-2', slug: 'ambiguous', name: 'Ambiguous', image_url: null },
        { id: 'artist-3', slug: 'ambiguous-2', name: 'ambiguous', image_url: null }, // normalizes identically → no matching
      ],
    });
    mocks.mockFetchAllAlbums.mockResolvedValue([
      { id: 'al-1', name: 'Illinois', artist: 'Sufjan Stevens' },
      { id: 'al-2', name: 'Some Album', artist: 'Ambiguous' },
      { id: 'al-3', name: 'Unknown Album', artist: 'Nobody We Know' },
    ]);

    await handler(internalEvent({ userId: 'user-1' }));
    const rows = upsertBatches.flat() as Record<string, unknown>[];
    const byExternal = Object.fromEntries(rows.map(r => [r.external_id as string, r]));
    expect(byExternal['al-1']).toMatchObject({ release_id: 'rel-1', art_url: 'https://f4.bcbits.com/a.jpg' });
    expect(byExternal['al-2'].release_id).toBeNull();
    expect(byExternal['al-3'].release_id).toBeNull();
  });

  // A re-sync used to upsert every album every time, and the table's updated_at trigger makes
  // any upsert a real row rewrite — 190 rewrites to record that nothing changed, repeated on
  // every retry of a stalled sync. These tests pin the diff: unchanged rows are not written,
  // and "no match this run" never erases what a previous run or the linker already stored.
  describe('re-sync write churn', () => {
    const ciphertext = () => encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));

    /** Route the two paged reads by label: artists for matching, stored items for the diff. */
    function withStored(existing: Record<string, unknown>[], artists: Record<string, unknown>[] = []) {
      mocks.mockReadAllPages.mockImplementation(async (_run: unknown, label: string) =>
        label.startsWith('collection_items') ? { ok: true, rows: existing } : { ok: true, rows: artists }
      );
    }

    const stored = (overrides: Record<string, unknown> = {}) => ({
      external_id: 'al-1',
      title: 'Illinois',
      artist_name: 'Sufjan Stevens',
      art_url: null,
      // Postgres serialization (+00:00), where Subsonic sends Z — a string compare would call
      // this changed and quietly turn the whole diff into a no-op. That's the point of the test.
      acquired_at: '2026-01-01T00:00:00+00:00',
      release_id: null,
      ...overrides,
    });

    const album = (overrides: Record<string, unknown> = {}) => ({
      id: 'al-1',
      name: 'Illinois',
      artist: 'Sufjan Stevens',
      created: '2026-01-01T00:00:00Z',
      ...overrides,
    });

    it('writes nothing when the stored collection already matches the library', async () => {
      const { upsertBatches, connectionUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
      });
      withStored([stored()]);
      mocks.mockFetchAllAlbums.mockResolvedValue([album()]);

      const res = await handler(internalEvent({ userId: 'user-1' }));

      expect(res.statusCode).toBe(200);
      expect(upsertBatches).toHaveLength(0);
      // The sync itself still completes and reports the full collection.
      expect(connectionUpdates.at(-1)).toMatchObject({ sync_status: 'idle', item_count: 1 });
    });

    it('writes only the rows that actually changed', async () => {
      const { upsertBatches } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
      });
      withStored([stored(), stored({ external_id: 'al-2', title: 'Old Title' })]);
      mocks.mockFetchAllAlbums.mockResolvedValue([
        album(),
        album({ id: 'al-2', name: 'Carrie & Lowell', created: null }),
        album({ id: 'al-3', name: 'Javelin' }), // the new purchase
      ]);

      await handler(internalEvent({ userId: 'user-1' }));

      const written = upsertBatches.flat().map(r => (r as Record<string, unknown>).external_id);
      expect(written.sort()).toEqual(['al-2', 'al-3']);
    });

    it('never erases a release link the linker set after the last sync', async () => {
      const { upsertBatches } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
      });
      // Stored row is linked; this run matches nothing (no artists), so the built row would
      // carry release_id: null. Null means "no new information", not "unlink".
      withStored([stored({ release_id: 'rel-1', art_url: 'https://f4.bcbits.com/a.jpg' })]);
      mocks.mockFetchAllAlbums.mockResolvedValue([album()]);

      await handler(internalEvent({ userId: 'user-1' }));

      expect(upsertBatches).toHaveLength(0);
    });

    it('does write a newly matched release link', async () => {
      const { upsertBatches } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        releases: [
          { id: 'rel-1', artist_id: 'artist-1', match_key: 'illinois', artwork_url: 'https://f4.bcbits.com/a.jpg' },
        ],
      });
      withStored([stored()], [SUFJAN]);
      mocks.mockFetchAllAlbums.mockResolvedValue([album()]);

      await handler(internalEvent({ userId: 'user-1' }));

      const rows = upsertBatches.flat();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ external_id: 'al-1', release_id: 'rel-1' });
    });

    it('falls back to writing everything when the stored read fails', async () => {
      const { upsertBatches } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
      });
      mocks.mockReadAllPages.mockImplementation(async (_run: unknown, label: string) =>
        label.startsWith('collection_items')
          ? { ok: false, reason: 'read blipped' }
          : { ok: true, rows: [] }
      );
      mocks.mockFetchAllAlbums.mockResolvedValue([album()]);

      await handler(internalEvent({ userId: 'user-1' }));

      // Skipping a real update because a read blipped is the worse trade — write as before.
      expect(upsertBatches.flat()).toHaveLength(1);
    });
  });

  describe('auto-mark supported (spec OQ6: buying is supporting)', () => {
    const ciphertext = () => encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const albums = [{ id: 'al-1', name: 'Illinois', artist: 'Sufjan Stevens' }];

    function withArtists() {
      mocks.mockReadAllPages.mockResolvedValue({ ok: true, rows: [SUFJAN] });
      mocks.mockFetchAllAlbums.mockResolvedValue(albums);
    }

    it('saves a matched artist as supported when they have no saved row', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        savedRows: [],
      });
      withArtists();

      await handler(internalEvent({ userId: 'user-1' }));

      const inserted = savedInserts.flat();
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        user_id: 'user-1',
        artist_id: 'artist-1',
        artist_slug: 'sufjan-stevens',
        artist_name: 'Sufjan Stevens',
        supported: true,
      });
      expect(inserted[0].supported_at).toBeTruthy();
      expect(inserted[0].last_modified).toBeTruthy();
      expect(savedUpdates).toHaveLength(0);
    });

    it('upgrades an existing unsupported row instead of inserting', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        // No artist_id: the legacy shape, where only the slug identifies the artist.
        savedRows: [{ id: 'row-1', artist_slug: 'sufjan-stevens', supported: false, deleted: false }],
      });
      withArtists();

      await handler(internalEvent({ userId: 'user-1' }));

      expect(savedInserts).toHaveLength(0);
      expect(savedUpdates).toHaveLength(1);
      expect(savedUpdates[0].patch).toMatchObject({ supported: true });
      expect(savedUpdates[0].column).toBe('id');
      expect(savedUpdates[0].values).toEqual(['row-1']);
    });

    it('leaves an already-supported row untouched (original supported_at preserved)', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        savedRows: [{ id: 'row-1', artist_slug: 'sufjan-stevens', supported: true, deleted: false }],
      });
      withArtists();

      await handler(internalEvent({ userId: 'user-1' }));

      expect(savedInserts).toHaveLength(0);
      expect(savedUpdates).toHaveLength(0);
    });

    it('never resurrects a tombstoned row — permanent dismissal sticks across re-syncs', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        savedRows: [{ id: 'row-1', artist_slug: 'sufjan-stevens', supported: false, deleted: true }],
      });
      withArtists();

      await handler(internalEvent({ userId: 'user-1' }));

      expect(savedInserts).toHaveLength(0);
      expect(savedUpdates).toHaveLength(0);
    });

    // The two cases the slug-only lookup got wrong. A row saved from a search result is filed
    // under a synthetic slug (`sufjanstevens`), which the canonical slug never equals, so only
    // artist_id finds it — measured on production 2026-08-14, one import duplicated three of
    // Brandon's saved artists this way.
    it('upgrades a row saved under a synthetic slug rather than duplicating the artist', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        savedRows: [
          { id: 'row-1', artist_id: 'artist-1', artist_slug: 'sufjanstevens', supported: false, deleted: false },
        ],
      });
      withArtists();

      await handler(internalEvent({ userId: 'user-1' }));

      expect(savedInserts).toHaveLength(0);
      expect(savedUpdates).toHaveLength(1);
      expect(savedUpdates[0].column).toBe('id');
      expect(savedUpdates[0].values).toEqual(['row-1']);
    });

    it('never resurrects a tombstone filed under a synthetic slug', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        savedRows: [
          { id: 'row-1', artist_id: 'artist-1', artist_slug: 'sufjanstevens', supported: false, deleted: true },
        ],
      });
      withArtists();

      await handler(internalEvent({ userId: 'user-1' }));

      expect(savedInserts).toHaveLength(0);
      expect(savedUpdates).toHaveLength(0);
    });

    // The shape deduplicating an account leaves behind: the superseded row tombstoned, the
    // canonical one live. The tombstone must not be read as "artist dismissed" — that would
    // strand the live row unsupported through every future re-sync — and neither row may be
    // duplicated by a fresh insert.
    it('supports the live row when a tombstone for the same artist sits beside it', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
        savedRows: [
          { id: 'row-1', artist_id: 'artist-1', artist_slug: 'sufjanstevens', supported: false, deleted: true },
          { id: 'row-2', artist_id: 'artist-1', artist_slug: 'sufjan-stevens', supported: false, deleted: false },
        ],
      });
      withArtists();

      await handler(internalEvent({ userId: 'user-1' }));

      expect(savedInserts).toHaveLength(0);
      expect(savedUpdates).toHaveLength(1);
      expect(savedUpdates[0].column).toBe('id');
      expect(savedUpdates[0].values).toEqual(['row-2']);
    });

    it('marks nothing for unmatched artists', async () => {
      const { savedInserts, savedUpdates } = setupDb({
        connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext() },
      });
      mocks.mockReadAllPages.mockResolvedValue({ ok: true, rows: [SUFJAN] });
      mocks.mockFetchAllAlbums.mockResolvedValue([
        { id: 'al-9', name: 'Some Album', artist: 'Nobody We Know' },
      ]);

      await handler(internalEvent({ userId: 'user-1' }));

      expect(savedInserts).toHaveLength(0);
      expect(savedUpdates).toHaveLength(0);
    });
  });

  it('records an error — not a partial success — when the fetch dies mid-sync', async () => {
    const ciphertext = encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const { connectionUpdates, upsertBatches } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext },
    });
    mocks.mockFetchAllAlbums.mockRejectedValue(new SubsonicError('getAlbumList2: HTTP 500'));

    const res = await handler(internalEvent({ userId: 'user-1' }));
    expect(res.statusCode).toBe(500);
    expect(upsertBatches).toHaveLength(0);
    expect(connectionUpdates.at(-1)).toMatchObject({
      sync_status: 'error',
      sync_error: expect.stringContaining('Re-sync'),
    });
  });

  it('tells the user to reconnect when the stored credential is rejected', async () => {
    const ciphertext = encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const { connectionUpdates } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext },
    });
    mocks.mockFetchAllAlbums.mockRejectedValue(new SubsonicError('getAlbumList2: bad creds', 40));

    await handler(internalEvent({ userId: 'user-1' }));
    expect(connectionUpdates.at(-1)).toMatchObject({
      sync_status: 'error',
      sync_error: expect.stringContaining('reconnect'),
    });
  });

  it('marks the credential unusable when decryption fails, without calling Bandcamp', async () => {
    const { connectionUpdates } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: 'not.a.blob' },
    });

    const res = await handler(internalEvent({ userId: 'user-1' }));
    expect(res.statusCode).toBe(500);
    expect(mocks.mockFetchAllAlbums).not.toHaveBeenCalled();
    expect(connectionUpdates.at(-1)).toMatchObject({
      sync_status: 'error',
      sync_error: expect.stringContaining('reconnect'),
    });
  });

  it('looks for the artists behind unmatched items only after the import is recorded', async () => {
    const ciphertext = encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const { connectionUpdates } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext },
    });
    mocks.mockFetchAllAlbums.mockResolvedValue([
      { id: 'al-1', name: 'Bias', artist: 'King Triumph' },
    ]);
    // The order is the point: resolution probes Bandcamp for every unknown name, and a fan's
    // collection must be complete and visible before that starts rather than after it.
    mocks.mockResolveArtists.mockImplementation(() => {
      expect(connectionUpdates.at(-1)).toMatchObject({ sync_status: 'idle' });
      return Promise.resolve({ created: 1, catalogRequested: 1 });
    });

    const res = await handler(internalEvent({ userId: 'user-1' }));
    expect(res.statusCode).toBe(200);
    expect(mocks.mockResolveArtists).toHaveBeenCalledWith('user-1');
    expect(JSON.parse(res.body).resolved).toMatchObject({ created: 1 });
  });

  it('still resolves stored artists when Bandcamp refuses to hand over the collection', async () => {
    const ciphertext = encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const { connectionUpdates } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext },
    });
    mocks.mockFetchAllAlbums.mockRejectedValue(
      new SubsonicError('getAlbumList2: HTTP 500 (offset 0, size 100)', null, true)
    );
    mocks.mockResolveArtists.mockResolvedValue({ created: 3, catalogRequested: 3 });

    const res = await handler(internalEvent({ userId: 'user-1' }));

    // The sync failed and says so. Resolution reads items imported by *earlier* syncs and
    // never touches the Subsonic API, so a Bandcamp outage has no business blocking it —
    // that coupling is what a real HTTP 500 exposed on the day this shipped.
    expect(res.statusCode).toBe(500);
    expect(connectionUpdates.at(-1)).toMatchObject({ sync_status: 'error' });
    expect(mocks.mockResolveArtists).toHaveBeenCalledWith('user-1');
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Sync failed', resolved: { created: 3 } });
  });

  it('still reports a successful import when artist resolution fails', async () => {
    const ciphertext = encryptCredential(JSON.stringify({ t: 'tok', s: 'salt' }));
    const { connectionUpdates, upsertBatches } = setupDb({
      connectionRow: { bandcamp_username: 'fan', credential_ciphertext: ciphertext },
    });
    mocks.mockFetchAllAlbums.mockResolvedValue([
      { id: 'al-1', name: 'Bias', artist: 'King Triumph' },
    ]);
    mocks.mockResolveArtists.mockRejectedValue(new Error('bandcamp said no'));

    const res = await handler(internalEvent({ userId: 'user-1' }));
    // The items are imported and the connection is idle. Discovery is an extra on top of a
    // finished sync, so its failure must never be recorded as a failed import.
    expect(res.statusCode).toBe(200);
    expect(upsertBatches.flat()).toHaveLength(1);
    expect(connectionUpdates.at(-1)).toMatchObject({ sync_status: 'idle', sync_error: null });
    expect(JSON.parse(res.body).resolved).toBeNull();
  });
});
