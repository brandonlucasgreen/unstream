import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
  deriveSubsonicToken,
  subsonicPing,
  subsonicArtistCount,
  subsonicFetchAllAlbums,
  subsonicFetchCollection,
  SubsonicError,
  SUBSONIC_SERVER,
} from '../bandcamp-subsonic';

const CRED = { username: 'fan', t: 'deadbeef', s: 'salt1234' };

function okEnvelope(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...extra } }),
  } as Response;
}

/**
 * Runs a call that may back off between retries without waiting out the backoff. The
 * rejection is captured before timers advance so it never surfaces as an unhandled one.
 */
async function runWithTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const settled = run().then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error })
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    vi.useRealTimers();
  }
}

describe('bandcamp-subsonic', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('deriveSubsonicToken', () => {
    it('derives t = md5(password + s) with a fresh salt each time', () => {
      const a = deriveSubsonicToken('hunter2');
      const b = deriveSubsonicToken('hunter2');
      expect(a.s).not.toBe(b.s);
      expect(a.t).toBe(createHash('md5').update('hunter2' + a.s).digest('hex'));
      expect(b.t).toBe(createHash('md5').update('hunter2' + b.s).digest('hex'));
    });

    it('never embeds the password in the token pair', () => {
      const { t, s } = deriveSubsonicToken('supersecret');
      expect(t).not.toContain('supersecret');
      expect(s).not.toContain('supersecret');
    });
  });

  describe('subsonicPing', () => {
    it('resolves on an ok envelope and targets the Bandcamp server', async () => {
      fetchMock.mockResolvedValue(okEnvelope());
      await subsonicPing(CRED);
      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.origin + url.pathname).toBe(`${SUBSONIC_SERVER}/rest/ping.view`);
      expect(url.searchParams.get('u')).toBe('fan');
      expect(url.searchParams.get('t')).toBe('deadbeef');
      expect(url.searchParams.get('s')).toBe('salt1234');
      expect(url.searchParams.get('f')).toBe('json');
    });

    it('throws an auth-flagged SubsonicError on error code 40', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          'subsonic-response': {
            status: 'failed',
            error: { code: 40, message: 'Wrong username or password' },
          },
        }),
      } as Response);
      const err = await subsonicPing(CRED).catch(e => e);
      expect(err).toBeInstanceOf(SubsonicError);
      expect(err.isAuthFailure).toBe(true);
    });

    it('throws on HTTP failure without leaking the URL', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
      const err = await subsonicPing(CRED).catch(e => e);
      expect(err).toBeInstanceOf(SubsonicError);
      expect(err.message).not.toContain('deadbeef');
      expect(err.message).not.toContain('salt1234');
      expect(err.message).not.toContain('bandcamp.com');
    });

    it('throws on a non-JSON response (bot challenge lookalike)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response);
      await expect(subsonicPing(CRED)).rejects.toThrow('non-JSON response');
    });
  });

  describe('subsonicArtistCount', () => {
    it('sums artists across index buckets', async () => {
      fetchMock.mockResolvedValue(
        okEnvelope({
          artists: {
            index: [
              { name: 'A', artist: [{ id: '1' }, { id: '2' }] },
              { name: 'B', artist: [{ id: '3' }] },
            ],
          },
        })
      );
      expect(await subsonicArtistCount(CRED)).toBe(3);
    });
  });

  describe('subsonicFetchAllAlbums', () => {
    const album = (id: number) => ({
      id: `al-${id}`,
      name: `Album ${id}`,
      artist: `Artist ${id}`,
      coverArt: `ar-${id}`,
      year: 2020,
      created: '2026-01-02T03:04:05.000Z',
    });

    it('collects albums and stops on a short page', async () => {
      const fullPage = Array.from({ length: 500 }, (_, i) => album(i));
      const shortPage = [album(500), album(501)];
      fetchMock
        .mockResolvedValueOnce(okEnvelope({ albumList2: { album: fullPage } }))
        .mockResolvedValueOnce(okEnvelope({ albumList2: { album: shortPage } }));

      const albums = await subsonicFetchAllAlbums(CRED);
      expect(albums).toHaveLength(502);
      expect(albums[0]).toMatchObject({ id: 'al-0', name: 'Album 0', artist: 'Artist 0' });

      const second = new URL(fetchMock.mock.calls[1][0] as string);
      expect(second.searchParams.get('offset')).toBe('500');
      expect(second.searchParams.get('type')).toBe('alphabeticalByArtist');
    });

    it('handles an empty collection', async () => {
      fetchMock.mockResolvedValue(okEnvelope({ albumList2: { album: [] } }));
      expect(await subsonicFetchAllAlbums(CRED)).toEqual([]);
    });

    it('skips malformed album entries rather than crashing', async () => {
      fetchMock.mockResolvedValue(
        okEnvelope({ albumList2: { album: [album(1), { id: 42 }, null, 'junk'] } })
      );
      const albums = await subsonicFetchAllAlbums(CRED);
      expect(albums).toHaveLength(1);
    });

    it('throws mid-pagination instead of returning a partial collection', async () => {
      const fullPage = Array.from({ length: 500 }, (_, i) => album(i));
      fetchMock
        .mockResolvedValueOnce(okEnvelope({ albumList2: { album: fullPage } }))
        .mockResolvedValue({ ok: false, status: 500 } as Response);
      await expect(runWithTimers(() => subsonicFetchAllAlbums(CRED))).rejects.toThrow(SubsonicError);
    });

    // Bandcamp's beta 500s on collections it imports fine at other times, so a failure is
    // retried, then retried smaller, before it is believed.
    it('retries a transient 500 and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
        .mockResolvedValueOnce(okEnvelope({ albumList2: { album: [album(1)] } }));

      const albums = await runWithTimers(() => subsonicFetchAllAlbums(CRED));
      expect(albums).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('asks for a smaller page when a page keeps failing, from the same offset', async () => {
      const fullPage = Array.from({ length: 500 }, (_, i) => album(i));
      fetchMock.mockImplementation((url: string) => {
        const params = new URL(url).searchParams;
        if (params.get('offset') === '0') {
          return Promise.resolve(okEnvelope({ albumList2: { album: fullPage } }));
        }
        // The second page is only servable in smaller bites.
        return params.get('size') === '500'
          ? Promise.resolve({ ok: false, status: 500 } as Response)
          : Promise.resolve(okEnvelope({ albumList2: { album: [album(500)] } }));
      });

      const albums = await runWithTimers(() => subsonicFetchAllAlbums(CRED));
      expect(albums).toHaveLength(501);

      const retried = new URL(fetchMock.mock.calls.at(-1)![0] as string).searchParams;
      expect(retried.get('offset')).toBe('500');
      expect(Number(retried.get('size'))).toBeLessThan(500);
    });

    it('names the page that failed, without leaking the credential', async () => {
      const fullPage = Array.from({ length: 500 }, (_, i) => album(i));
      fetchMock.mockImplementation((url: string) =>
        new URL(url).searchParams.get('offset') === '0'
          ? Promise.resolve(okEnvelope({ albumList2: { album: fullPage } }))
          : Promise.resolve({ ok: false, status: 500 } as Response)
      );

      const err = await runWithTimers(() => subsonicFetchAllAlbums(CRED)).catch(e => e);
      expect(err.message).toContain('offset 500');
      expect(err.message).not.toContain('deadbeef');
      expect(err.message).not.toContain('salt1234');
    });

    it('does not retry a rejected credential', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          'subsonic-response': {
            status: 'failed',
            error: { code: 40, message: 'Wrong username or password' },
          },
        }),
      } as Response);

      const err = await runWithTimers(() => subsonicFetchAllAlbums(CRED)).catch(e => e);
      expect(err.isAuthFailure).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
  describe('subsonicFetchCollection', () => {
    const fail = { ok: false, status: 500 } as Response;
    const artistsIndex = okEnvelope({
      artists: { index: [
        { name: 'B', artist: [{ id: 'ar-1', name: 'Broken Social Scene' }] },
        { name: 'H', artist: [{ id: 'ar-2', name: 'Honeycrush' }, { id: 'ar-3', name: 'Hop Along' }] },
      ] },
    });
    /** Bandcamp as the failing accounts see it: the album list fails, getArtist mostly works. */
    function bandcamp(artistAnswers: Record<string, Response>) {
      fetchMock.mockImplementation((url: string) => {
        const parsed = new URL(url);
        const method = parsed.pathname.split('/').pop();
        if (method === 'getAlbumList2.view') return Promise.resolve(fail);
        if (method === 'getArtists.view') return Promise.resolve(artistsIndex);
        if (method === 'getArtist.view') return Promise.resolve(artistAnswers[parsed.searchParams.get('id')!]);
        throw new Error(`unexpected ${method}`);
      });
    }
    const albumsOf = (artist: string, ids: string[]) => okEnvelope({
      artist: { name: artist, album: ids.map(id => ({ id, name: `Album ${id}`, artist, coverArt: `c-${id}` })) },
    });

    it('uses the album list when it answers, and never asks artist by artist', async () => {
      fetchMock.mockResolvedValue(okEnvelope({ albumList2: { album: [{ id: 'al-1', name: 'A', artist: 'X' }] } }));
      const result = await subsonicFetchCollection(CRED);
      expect(result).toEqual({ albums: [expect.objectContaining({ id: 'al-1' })], missingArtists: [], listFailure: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fetches artist by artist when the album list fails, and says why', async () => {
      bandcamp({
        'ar-1': albumsOf('Broken Social Scene', ['al-1', 'al-2']),
        'ar-2': albumsOf('Honeycrush', ['al-3']),
        'ar-3': albumsOf('Hop Along', ['al-4']),
      });
      const result = await runWithTimers(() => subsonicFetchCollection(CRED));
      expect(result.albums.map(a => a.id).sort()).toEqual(['al-1', 'al-2', 'al-3', 'al-4']);
      expect(result.albums.find(a => a.id === 'al-3')).toMatchObject({ name: 'Album al-3', artist: 'Honeycrush', coverArt: 'c-al-3' });
      expect(result.missingArtists).toEqual([]);
      expect(result.listFailure).toContain('getAlbumList2: HTTP 500 (offset 0, size 100)');
    });

    it('imports the rest when some artists won’t come, naming them', async () => {
      bandcamp({
        'ar-1': albumsOf('Broken Social Scene', ['al-1']),
        'ar-2': fail,
        'ar-3': albumsOf('Hop Along', ['al-4']),
      });
      const result = await runWithTimers(() => subsonicFetchCollection(CRED));
      expect(result.albums.map(a => a.id).sort()).toEqual(['al-1', 'al-4']);
      expect(result.missingArtists).toEqual(['Honeycrush']);
    });

    it('fills in the artist when getArtist doesn’t repeat it on each album', async () => {
      bandcamp({
        'ar-1': okEnvelope({ artist: { album: [{ id: 'al-1', name: 'You Forgot It in People' }] } }),
        'ar-2': okEnvelope({ artist: { album: [] } }),
        'ar-3': okEnvelope({ artist: { album: [] } }),
      });
      const result = await runWithTimers(() => subsonicFetchCollection(CRED));
      expect(result.albums).toEqual([expect.objectContaining({ id: 'al-1', artist: 'Broken Social Scene' })]);
    });

    it('fails outright when no artist comes, rather than reporting an empty collection', async () => {
      bandcamp({ 'ar-1': fail, 'ar-2': fail, 'ar-3': fail });
      await expect(runWithTimers(() => subsonicFetchCollection(CRED))).rejects.toThrow(SubsonicError);
    });

    it('fails outright when the artist index won’t come either', async () => {
      fetchMock.mockResolvedValue(fail);
      await expect(runWithTimers(() => subsonicFetchCollection(CRED))).rejects.toThrow(/getArtists/);
    });

    it('never tries another route with a rejected credential', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }),
      } as Response);
      const err = await runWithTimers(() => subsonicFetchCollection(CRED)).catch(e => e);
      expect(err.isAuthFailure).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops and throws if the credential is rejected partway through the artists', async () => {
      bandcamp({
        'ar-1': albumsOf('Broken Social Scene', ['al-1']),
        'ar-2': {
          ok: true,
          status: 200,
          json: async () => ({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }),
        } as Response,
        'ar-3': albumsOf('Hop Along', ['al-4']),
      });
      const err = await runWithTimers(() => subsonicFetchCollection(CRED)).catch(e => e);
      expect(err.isAuthFailure).toBe(true);
    });
  });
});
