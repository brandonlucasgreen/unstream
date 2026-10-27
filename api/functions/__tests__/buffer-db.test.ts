// The stored Buffer connection, and above all usableAccessToken.
//
// Buffer's access tokens last an hour and its refresh tokens are SINGLE-USE: replaying one
// revokes the whole grant and silently disconnects the curator. So the rules worth locking are
// that a token is never used past its life, that a refresh writes the replacement back under a
// compare-and-set, and that the loser of a race takes the winner's token instead of refreshing
// again with one Buffer has already retired.

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

function stubSelectThenUpdate(data: unknown, updated: unknown[], afterUpdate?: unknown) {
  let selects = 0;
  from.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: selects++ === 0 ? data : (afterUpdate ?? data), error: null }),
      }),
    }),
    update: (patch: Record<string, unknown>) => ({
      eq: () => ({
        eq: () => ({ select: async () => { lastPatch = patch; return { data: updated, error: null }; } }),
      }),
    }),
    delete: () => ({ eq: async () => ({ error: null }) }),
  }));
}

let lastPatch: Record<string, unknown> = {};

beforeEach(() => { from.mockReset(); refreshTokens.mockReset(); captureMessage.mockReset(); lastPatch = {}; });
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
  it('uses a stored token that is still good, without calling Buffer', async () => {
    stubSelect(row());
    expect(await usableAccessToken('user-1')).toBe('stored-access');
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('refuses when the curator has no connection', async () => {
    stubSelect(null);
    await expect(usableAccessToken('user-1')).rejects.toBeInstanceOf(BufferNotConnectedError);
  });

  it('refreshes an expired token and stores the replacement before returning it', async () => {
    refreshTokens.mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: new Date(Date.now() + hour) });
    stubSelectThenUpdate(row({ expires_at: new Date(Date.now() - 1).toISOString() }), [{ access_token_encrypted: 'enc(new-access)' }]);

    expect(await usableAccessToken('user-1')).toBe('new-access');
    expect(refreshTokens).toHaveBeenCalledWith('stored-refresh');
    // The replacement refresh token is written back; losing it would cost the connection.
    expect(lastPatch.refresh_token_encrypted).toBe('enc(new-refresh)');
    expect(lastPatch.refresh_counter).toBe(4);
  });

  // The skew: a token minutes from expiry is refreshed now rather than lapsing mid-call.
  it('refreshes one that is about to expire', async () => {
    refreshTokens.mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: new Date(Date.now() + hour) });
    stubSelectThenUpdate(row({ expires_at: new Date(Date.now() + 10_000).toISOString() }), [{}]);
    await usableAccessToken('user-1');
    expect(refreshTokens).toHaveBeenCalled();
  });

  // The hazard this whole design exists for. Our refresh token is spent the moment Buffer
  // answers, so the loser must NOT refresh again — it takes the winner's token.
  it('takes the winner’s token when another request refreshed first', async () => {
    refreshTokens.mockResolvedValue({ accessToken: 'ours', refreshToken: 'ours-refresh', expiresAt: new Date(Date.now() + hour) });
    stubSelectThenUpdate(
      row({ expires_at: new Date(Date.now() - 1).toISOString() }),
      [],                                                   // compare-and-set matched nothing
      row({ access_token_encrypted: 'enc(winners-access)' }),
    );

    expect(await usableAccessToken('user-1')).toBe('winners-access');
    expect(refreshTokens).toHaveBeenCalledTimes(1);          // never a second attempt
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('concurrent refresh'), expect.anything());
  });

  it('clears the connection and asks for a reconnect when Buffer rejects the grant', async () => {
    refreshTokens.mockRejectedValue(new BufferError(400, 'invalid_grant'));
    stubSelectThenUpdate(row({ expires_at: new Date(Date.now() - 1).toISOString() }), []);

    await expect(usableAccessToken('user-1')).rejects.toMatchObject({
      name: 'BufferNotConnectedError',
      message: expect.stringContaining('Reconnect'),
    });
  });

  // Without offline_access there is no refresh token, so nothing can revive this connection.
  it('clears a connection that has no refresh token to use', async () => {
    stubSelectThenUpdate(row({ expires_at: new Date(Date.now() - 1).toISOString(), refresh_token_encrypted: null }), []);
    await expect(usableAccessToken('user-1')).rejects.toMatchObject({ name: 'BufferNotConnectedError' });
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  // A network blip is not a dead grant; clearing the connection would log the curator out for it.
  it('lets a transport failure through rather than disconnecting the curator', async () => {
    refreshTokens.mockRejectedValue(new BufferError(503, 'Service unavailable'));
    stubSelectThenUpdate(row({ expires_at: new Date(Date.now() - 1).toISOString() }), []);
    await expect(usableAccessToken('user-1')).rejects.toMatchObject({ name: 'BufferError', status: 503 });
  });
});
