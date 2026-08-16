import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCreateClient: vi.fn(),
  mockCheckRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
  mockPing: vi.fn(),
  mockArtistCount: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => ({ from: mocks.mockFrom }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.mockCreateClient }));
vi.mock('../ratelimit', () => ({
  // Only a bucket name; the endpoints' own auth is mocked separately.
  accountRateLimitKey: async () => 'user:test-user',
  checkRateLimit: mocks.mockCheckRateLimit,
  getClientIp: mocks.mockGetClientIp,
}));
vi.mock('../bandcamp-subsonic', async importOriginal => {
  const original = await importOriginal<typeof import('../bandcamp-subsonic')>();
  return {
    ...original,
    subsonicPing: mocks.mockPing,
    subsonicArtistCount: mocks.mockArtistCount,
  };
});

import { handler, selfDispatchOrigin } from '../me-bandcamp';
import { SubsonicError } from '../bandcamp-subsonic';
import { decryptCredential } from '../credential-crypto';

// The dispatch target carries INTERNAL_FUNCTION_SECRET, and Host is client-supplied, so
// this allowlist is a security boundary, not a convenience.
describe('selfDispatchOrigin', () => {
  it('accepts this site\'s own production and Netlify deploy hostnames', () => {
    expect(selfDispatchOrigin('unstream.stream')).toBe('https://unstream.stream');
    expect(selfDispatchOrigin('www.unstream.stream')).toBe('https://www.unstream.stream');
    expect(selfDispatchOrigin('unstream.netlify.app')).toBe('https://unstream.netlify.app');
    expect(selfDispatchOrigin('deploy-preview-438--unstream.netlify.app')).toBe(
      'https://deploy-preview-438--unstream.netlify.app'
    );
    // Case and port are normalised away before matching.
    expect(selfDispatchOrigin('Unstream.Stream:443')).toBe('https://unstream.stream');
  });

  it('refuses any hostname that is not ours, so the secret cannot be redirected', () => {
    for (const host of [
      'evil.com',
      'unstream.stream.evil.com',
      'unstream.netlify.app.evil.com',
      'evil.com--unstream.netlify.app',
      'deploy-preview-438--unstream.netlify.app.evil.com',
      'notunstream.stream',
      '169.254.169.254',
      'localhost',
      '',
      undefined,
    ]) {
      expect(selfDispatchOrigin(host)).toBeNull();
    }
  });
});

const PASSWORD = 'bandcamp-generated-credential';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function authedEvent(method: string, body: unknown = null) {
  return {
    httpMethod: method,
    headers: { authorization: 'Bearer valid-token' },
    body: body === null ? null : JSON.stringify(body),
  };
}

describe('me-bandcamp handler', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.BANDCAMP_CREDENTIAL_KEY = randomBytes(32).toString('base64');
    process.env.INTERNAL_FUNCTION_SECRET = 'internal-secret';
    process.env.URL = 'https://unstream.stream';
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    mocks.mockCreateClient.mockReturnValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1' } },
          error: null,
        }),
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BANDCAMP_CREDENTIAL_KEY;
    delete process.env.INTERNAL_FUNCTION_SECRET;
    delete process.env.URL;
  });

  /** One connection row answering the GET's select().eq().maybeSingle() chain. */
  function mockConnectionRow(row: Record<string, unknown>) {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { bandcamp_username: 'fan', ...row }, error: null })),
        })),
      })),
    });
  }

  it('returns 401 when not authenticated', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {}, body: null });
    expect(res!.statusCode).toBe(401);
  });

  it('GET reports not connected when there is no row', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
    });
    const res = await handler(authedEvent('GET'));
    expect(res!.statusCode).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ connected: false });
  });

  // A sync that Netlify killed leaves the row claiming 'syncing' forever. The settings page
  // hides Re-sync while a sync runs, so believing that row strands the user on "Importing…".
  it('GET reports a long-running sync as a failure the user can retry', async () => {
    mockConnectionRow({ sync_status: 'syncing', sync_error: null, updated_at: hoursAgo(1) });
    const body = JSON.parse((await handler(authedEvent('GET')))!.body);
    expect(body.syncStatus).toBe('error');
    expect(body.syncError).toContain('Re-sync');
  });

  it('GET still reports a recently started sync as running', async () => {
    mockConnectionRow({
      sync_status: 'syncing',
      sync_error: null,
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const body = JSON.parse((await handler(authedEvent('GET')))!.body);
    expect(body.syncStatus).toBe('syncing');
    expect(body.syncError).toBeNull();
  });

  it('GET returns connection status without any credential material', async () => {
    mocks.mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() =>
            Promise.resolve({
              data: {
                bandcamp_username: 'fan',
                sync_status: 'idle',
                sync_error: null,
                item_count: 42,
                last_synced_at: '2026-08-09T00:00:00Z',
              },
              error: null,
            })
          ),
        })),
      })),
    });
    const res = await handler(authedEvent('GET'));
    const body = JSON.parse(res!.body);
    expect(body).toMatchObject({ connected: true, username: 'fan', itemCount: 42, syncStatus: 'idle' });
    expect(res!.body).not.toContain('ciphertext');
  });

  describe('POST connect', () => {
    it('rejects a bad credential inline (Subsonic error 40) and stores nothing', async () => {
      mocks.mockPing.mockRejectedValue(new SubsonicError('ping: wrong credentials', 40));
      const res = await handler(authedEvent('POST', { username: 'fan', password: PASSWORD }));
      expect(res!.statusCode).toBe(400);
      expect(JSON.parse(res!.body).error).toContain('rejected');
      expect(mocks.mockFrom).not.toHaveBeenCalled();
      expect(res!.body).not.toContain(PASSWORD);
    });

    it('returns 502 when Bandcamp is unreachable, storing nothing', async () => {
      mocks.mockPing.mockRejectedValue(new SubsonicError('ping: timed out'));
      const res = await handler(authedEvent('POST', { username: 'fan', password: PASSWORD }));
      expect(res!.statusCode).toBe(502);
      expect(mocks.mockFrom).not.toHaveBeenCalled();
    });

    it('returns 500 when the encryption key is not configured', async () => {
      delete process.env.BANDCAMP_CREDENTIAL_KEY;
      const res = await handler(authedEvent('POST', { username: 'fan', password: PASSWORD }));
      expect(res!.statusCode).toBe(500);
      expect(mocks.mockPing).not.toHaveBeenCalled();
    });

    it('stores an encrypted, decryptable token pair — never the password — and starts a sync', async () => {
      mocks.mockPing.mockResolvedValue(undefined);
      mocks.mockArtistCount.mockResolvedValue(37);
      const upsert = vi.fn((..._args: unknown[]) => Promise.resolve({ error: null }));
      mocks.mockFrom.mockReturnValue({ upsert });

      const res = await handler(authedEvent('POST', { username: 'fan', password: PASSWORD }));
      expect(res!.statusCode).toBe(200);
      expect(JSON.parse(res!.body)).toMatchObject({
        connected: true,
        username: 'fan',
        syncStatus: 'syncing',
        artistCount: 37,
      });

      const stored = upsert.mock.calls[0]![0] as Record<string, string>;
      expect(stored.sync_status).toBe('syncing');
      expect(stored.credential_ciphertext).not.toContain(PASSWORD);
      const decrypted = JSON.parse(decryptCredential(stored.credential_ciphertext));
      expect(decrypted).toHaveProperty('t');
      expect(decrypted).toHaveProperty('s');
      expect(decrypted.t).not.toContain(PASSWORD);

      // The ping was made with the same derived pair that was stored.
      const pinged = mocks.mockPing.mock.calls[0][0];
      expect(pinged).toMatchObject({ username: 'fan', t: decrypted.t, s: decrypted.s });

      // The background sync was requested with the internal secret, after the upsert.
      expect(fetchMock).toHaveBeenCalledWith(
        'https://unstream.stream/.netlify/functions/bandcamp-sync-background',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer internal-secret' }),
          body: JSON.stringify({ userId: 'user-1' }),
        })
      );
    });

    it('records a sync-start failure on the row instead of claiming a sync is running', async () => {
      mocks.mockPing.mockResolvedValue(undefined);
      mocks.mockArtistCount.mockResolvedValue(1);
      delete process.env.INTERNAL_FUNCTION_SECRET; // sync can't be requested
      const upsert = vi.fn(() => Promise.resolve({ error: null }));
      const updateEq = vi.fn(() => Promise.resolve({ error: null }));
      const update = vi.fn(() => ({ eq: updateEq }));
      mocks.mockFrom.mockReturnValue({ upsert, update });

      const res = await handler(authedEvent('POST', { username: 'fan', password: PASSWORD }));
      expect(JSON.parse(res!.body).syncStatus).toBe('error');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ sync_status: 'error', sync_error: expect.stringContaining('Re-sync') })
      );
    });

    it('treats a non-202 dispatch (e.g. 404 on a deploy preview) as sync-start failure', async () => {
      mocks.mockPing.mockResolvedValue(undefined);
      mocks.mockArtistCount.mockResolvedValue(1);
      // The background function isn't deployed at the target URL — Netlify answers 404,
      // which fetch does NOT throw on. Claiming "syncing" here would spin forever.
      fetchMock.mockResolvedValue({ ok: false, status: 404 });
      const upsert = vi.fn((..._args: unknown[]) => Promise.resolve({ error: null }));
      const updateEq = vi.fn(() => Promise.resolve({ error: null }));
      const update = vi.fn(() => ({ eq: updateEq }));
      mocks.mockFrom.mockReturnValue({ upsert, update });

      const res = await handler(authedEvent('POST', { username: 'fan', password: PASSWORD }));
      expect(JSON.parse(res!.body).syncStatus).toBe('error');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ sync_status: 'error', sync_error: expect.stringContaining('Re-sync') })
      );
    });

    it('dispatches to the deploy that served the request, not always production', async () => {
      // The bug this fixes: a deploy preview handed its sync to production, where the
      // branch's background function 404s.
      mocks.mockPing.mockResolvedValue(undefined);
      mocks.mockArtistCount.mockResolvedValue(1);
      const upsert = vi.fn((..._args: unknown[]) => Promise.resolve({ error: null }));
      mocks.mockFrom.mockReturnValue({ upsert });

      await handler({
        httpMethod: 'POST',
        headers: {
          authorization: 'Bearer valid-token',
          host: 'deploy-preview-438--unstream.netlify.app',
        },
        body: JSON.stringify({ username: 'fan', password: PASSWORD }),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://deploy-preview-438--unstream.netlify.app/.netlify/functions/bandcamp-sync-background',
        expect.anything()
      );
    });

    it('ignores a spoofed Host, so the internal secret never leaves our own deploys', async () => {
      mocks.mockPing.mockResolvedValue(undefined);
      mocks.mockArtistCount.mockResolvedValue(1);
      const upsert = vi.fn((..._args: unknown[]) => Promise.resolve({ error: null }));
      mocks.mockFrom.mockReturnValue({ upsert });

      await handler({
        httpMethod: 'POST',
        headers: { authorization: 'Bearer valid-token', host: 'evil.example.com' },
        body: JSON.stringify({ username: 'fan', password: PASSWORD }),
      });

      const dispatched = fetchMock.mock.calls[0][0] as string;
      expect(dispatched).toBe('https://unstream.stream/.netlify/functions/bandcamp-sync-background');
      expect(dispatched).not.toContain('evil.example.com');
    });

    it('validates the body', async () => {
      const res = await handler(authedEvent('POST', { username: '', password: PASSWORD }));
      expect(res!.statusCode).toBe(400);
      const res2 = await handler(authedEvent('POST', { username: 'fan' }));
      expect(res2!.statusCode).toBe(400);
    });
  });

  describe('POST resync', () => {
    it('404s when there is no connection', async () => {
      mocks.mockFrom.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
          })),
        })),
      });
      const res = await handler(authedEvent('POST', { resync: true }));
      expect(res!.statusCode).toBe(404);
    });

    it('409s when a sync is already running', async () => {
      mocks.mockFrom.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() =>
              Promise.resolve({
                data: { sync_status: 'syncing', updated_at: new Date().toISOString() },
                error: null,
              })
            ),
          })),
        })),
      });
      const res = await handler(authedEvent('POST', { resync: true }));
      expect(res!.statusCode).toBe(409);
    });

    // Netlify kills a background function at 15 minutes, and it dies without recording an
    // error — so refusing here would leave the user with no way to retry, ever.
    it('starts a sync when the running one is old enough to be dead', async () => {
      const row = { sync_status: 'syncing', updated_at: hoursAgo(1) };
      const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
      mocks.mockFrom.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: row, error: null })),
            single: vi.fn(() =>
              Promise.resolve({
                data: { ...row, bandcamp_username: 'fan', updated_at: new Date().toISOString() },
                error: null,
              })
            ),
          })),
        })),
        update,
      });

      const res = await handler(authedEvent('POST', { resync: true }));
      expect(res!.statusCode).toBe(200);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ sync_status: 'syncing', sync_error: null })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'https://unstream.stream/.netlify/functions/bandcamp-sync-background',
        expect.anything()
      );
    });
  });

  describe('DELETE', () => {
    it('deletes the connection, leaving items by default', async () => {
      const deleteEq = vi.fn(() => Promise.resolve({ error: null }));
      mocks.mockFrom.mockReturnValue({ delete: vi.fn(() => ({ eq: deleteEq })) });

      const res = await handler(authedEvent('DELETE', {}));
      expect(res!.statusCode).toBe(200);
      expect(JSON.parse(res!.body)).toEqual({ connected: false, itemsDeleted: 0 });
      expect(mocks.mockFrom).toHaveBeenCalledWith('bandcamp_connections');
      expect(mocks.mockFrom).not.toHaveBeenCalledWith('collection_items');
    });

    it('deletes imported items when asked, scoped to source=bandcamp', async () => {
      const connectionEq = vi.fn(() => Promise.resolve({ error: null }));
      const sourceEq = vi.fn(() => Promise.resolve({ count: 12, error: null }));
      const userEq = vi.fn(() => ({ eq: sourceEq }));
      mocks.mockFrom.mockImplementation((table: string) =>
        table === 'bandcamp_connections'
          ? { delete: vi.fn(() => ({ eq: connectionEq })) }
          : { delete: vi.fn(() => ({ eq: userEq })) }
      );

      const res = await handler(authedEvent('DELETE', { deleteItems: true }));
      expect(res!.statusCode).toBe(200);
      expect(JSON.parse(res!.body)).toEqual({ connected: false, itemsDeleted: 12 });
      expect(userEq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(sourceEq).toHaveBeenCalledWith('source', 'bandcamp');
    });
  });
});
