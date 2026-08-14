import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
  deriveSubsonicToken,
  subsonicPing,
  subsonicArtistCount,
  subsonicFetchAllAlbums,
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
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response);
      await expect(subsonicFetchAllAlbums(CRED)).rejects.toThrow(SubsonicError);
    });
  });
});
