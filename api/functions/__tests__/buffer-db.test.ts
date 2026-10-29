// The stored Buffer connection, and above all usableAccessToken.
//
// Buffer's access tokens last an hour and its refresh tokens are SINGLE-USE: "Reusing an old
// refresh token revokes all tokens for that grant." So the rules worth locking are that a token is
// never used past its life, that only ONE request ever sends a given refresh token (the refresh
// is claimed in the database first), that everyone else waits for the new one, and that a
// connection is never dropped silently.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const from = vi.fn();
const refreshTokens = vi.fn();
const captureMessage = vi.fn();

vi.mock('../db', () => ({ getClient: () => ({ from: (...a: unknown[]) => from(...a) }) }));

vi.mock('../credential-crypto', () => ({
  isCredentialKeyConfigured: () => true,
  // Reversible stand-ins, so a test can see which token was stored.
  encryptCredential: (plain: string) => `enc(${plain})`,
  decryptCredential: (blob: string) => blob.replace(/^enc\(|\)$/g, ''),
}));

vi.mock('../buffer-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../buffer-oauth')>()),
  refreshTokens: (...a: unknown[]) => refreshTokens(...a),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: (...a: unknown[]) => captureMessage(...a), captureException: vi.fn() },
  withSentry: (h: unknown) => h,
}));

const { BufferNotConnectedError, getBufferConnection, usableAccessToken } = await import('../buffer-db');
const { BufferError } = await import('../buffer-client');

const hour = 3_600_000;

function row(over: Record<string, unknown> = {}) {
  return {
    access_token_encrypted: 'enc(stored-access)',
    refresh_token_encrypted: 'enc(stored-refresh)',
    expires_at: new Date(Date.now() + hour).toISOString(),
    organization_id: 'org_1',
    selected_channel_ids: ['chan_ig'],
    refresh_counter: 3,
    ...over,
  };
}

/** A Supabase query builder stubbed down to the two shapes this module uses. */
function stubSelect(data: unknown) {
  from.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }),
  });
}

beforeEach(() => { from.mockReset(); refreshTokens.mockReset(); captureMessage.mockReset(); });
afterEach(() => { vi.clearAllMocks(); });

describe('getBufferConnection', () => {
  it('decrypts both tokens and reports what the curator chose', async () => {
    stubSelect(row());
    const connection = await getBufferConnection('user-1');
    expect(connection).toMatchObject({
      accessToken: 'stored-access',
      refreshToken: 'stored-refresh',
      organizationId: 'org_1',
      selectedChannelIds: ['chan_ig'],
      refreshCounter: 3,
    });
  });

  it('is null when this curator has never connected', async () => {
    stubSelect(null);
    expect(await getBufferConnection('user-1')).toBeNull();
  });

  it('reports no chosen channels as an empty list, not null', async () => {
    stubSelect(row({ selected_channel_ids: null }));
    expect((await getBufferConnection('user-1'))!.selectedChannelIds).toEqual([]);
  });
});

describe('usableAccessToken', () => {
  // An in-memory buffer_connections row, with just enough of Supabase's query builder: select by
  // user, conditional update (every .eq() must match), delete. Enough to race two requests.
  let table: Record<string, unknown> | null;
  let blockClaims = false;

  function fakeTable(initial: Record<string, unknown> | null) {
    table = initial;
    from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table ? { ...table } : null, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
          select: async () => {
            if (!table) return { data: [], error: null };
            if (blockClaims && 'refresh_counter' in patch) return { data: [], error: null };
            const matches = Object.entries(filters).every(([c, v]) => c === 'user_id' || table![c] === v);
            if (!matches) return { data: [], error: null };
            table = { ...table, ...patch };
            return { data: [table], error: null };
          },
        };
        return chain;
      },
      delete: () => ({ eq: async () => { table = null; return { error: null }; } }),
    }));
  }

  const expired = () => row({ expires_at: new Date(Date.now() - 1).toISOString() });
  const fresh = (access = 'new-access', refresh: string | null = 'new-refresh') =>
    ({ accessToken: access, refreshToken: refresh, expiresAt: new Date(Date.now() + hour) });

  afterEach(() => { blockClaims = false; vi.useRealTimers(); });

  it('uses a stored token that is still good, without calling Buffer', async () => {
    fakeTable(row());
    expect(await usableAccessToken('user-1')).toBe('stored-access');
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('refuses when the user has no connection', async () => {
    fakeTable(null);
    await expect(usableAccessToken('user-1')).rejects.toBeInstanceOf(BufferNotConnectedError);
  });

  it('claims the refresh, then stores the replacement before returning it', async () => {
    refreshTokens.mockResolvedValue(fresh());
    fakeTable(expired());

    expect(await usableAccessToken('user-1')).toBe('new-access');
    expect(refreshTokens).toHaveBeenCalledWith('stored-refresh');
    // The replacement refresh token is written back; losing it would cost the connection.
    expect(table).toMatchObject({ refresh_token_encrypted: 'enc(new-refresh)', access_token_encrypted: 'enc(new-access)', refresh_counter: 4 });
  });

  // The skew: a token minutes from expiry is refreshed now rather than lapsing mid-call.
  it('refreshes one that is about to expire', async () => {
    refreshTokens.mockResolvedValue(fresh());
    fakeTable(row({ expires_at: new Date(Date.now() + 10_000).toISOString() }));
    await usableAccessToken('user-1');
    expect(refreshTokens).toHaveBeenCalled();
  });

  // The bug behind "reconnect Buffer after every deploy" (2026-10-29): a page loading its data
  // twice at once sent the same refresh token twice, and Buffer revoked the whole grant.
  it('sends a refresh token to Buffer once, however many requests need a token at the same time', async () => {
    refreshTokens.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(fresh()), 50)));
    fakeTable(expired());

    const tokens = await Promise.all([usableAccessToken('user-1'), usableAccessToken('user-1'), usableAccessToken('user-1')]);

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(['new-access', 'new-access', 'new-access']);
    expect(table).not.toBeNull();
  });

  it('gives up waiting for someone else’s refresh without touching the connection', async () => {
    vi.useFakeTimers();
    blockClaims = true;
    fakeTable(expired());

    const attempt = usableAccessToken('user-1');
    const settled = attempt.catch(error => error);
    await vi.advanceTimersByTimeAsync(9_000);

    expect(await settled).toMatchObject({ name: 'BufferError', status: 503 });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(table).not.toBeNull();
  });

  it('clears the connection, says why in Sentry, and asks for a reconnect when Buffer rejects the grant', async () => {
    refreshTokens.mockRejectedValue(new BufferError(400, 'invalid_grant'));
    fakeTable(expired());

    await expect(usableAccessToken('user-1')).rejects.toMatchObject({
      name: 'BufferNotConnectedError',
      message: expect.stringContaining('Reconnect'),
    });
    expect(table).toBeNull();
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('connection dropped'), expect.objectContaining({
      extra: expect.objectContaining({ reason: expect.stringContaining('invalid_grant') }),
    }));
  });

  // Without offline_access there is no refresh token, so nothing can revive this connection.
  it('clears a connection that has no refresh token to use, and says so', async () => {
    fakeTable(row({ expires_at: new Date(Date.now() - 1).toISOString(), refresh_token_encrypted: null }));
    await expect(usableAccessToken('user-1')).rejects.toMatchObject({ name: 'BufferNotConnectedError' });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('connection dropped'), expect.anything());
  });

  // A network blip is not a dead grant; clearing the connection would sign the user out for it.
  it('lets a transport failure through rather than disconnecting the user', async () => {
    refreshTokens.mockRejectedValue(new BufferError(503, 'Service unavailable'));
    fakeTable(expired());
    await expect(usableAccessToken('user-1')).rejects.toMatchObject({ name: 'BufferError', status: 503 });
    expect(table).not.toBeNull();
  });

  it('reports a refresh that came back without a new refresh token, before it costs the connection', async () => {
    refreshTokens.mockResolvedValue(fresh('new-access', null));
    fakeTable(expired());
    expect(await usableAccessToken('user-1')).toBe('new-access');
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('no new refresh token'), expect.anything());
  });
});
