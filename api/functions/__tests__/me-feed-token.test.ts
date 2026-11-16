// /api/me/feed-token: the private release feed's only credential. Locked here: a token is minted
// on the first GET and not again, POST replaces it, DELETE removes it, a failed write is never
// reported as success, and no answer that carries the token may be cached anywhere shared.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFeedToken: vi.fn(),
  setFeedToken: vi.fn(),
  deleteFeedToken: vi.fn(),
  resolveAccountRequest: vi.fn(),
}));

vi.mock('../db', () => ({
  getFeedToken: mocks.getFeedToken,
  setFeedToken: mocks.setFeedToken,
  deleteFeedToken: mocks.deleteFeedToken,
}));
vi.mock('../ratelimit', () => ({
  resolveAccountRequest: mocks.resolveAccountRequest,
  checkRateLimit: async () => ({ limited: false }),
  getClientIp: () => '203.0.113.7',
}));

import { handler } from '../me-feed-token';

const call = async (httpMethod: string) => {
  const res = await handler({ httpMethod, headers: { authorization: 'Bearer t' } });
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body || '{}') };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:u1', user: { userId: 'u1', email: 'fan@example.com' } });
  mocks.getFeedToken.mockResolvedValue(null);
  mocks.setFeedToken.mockResolvedValue(true);
  mocks.deleteFeedToken.mockResolvedValue(true);
});

describe('me-feed-token', () => {
  it('needs a signed-in account, and touches no token without one', async () => {
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'ip:203.0.113.7', user: null });

    for (const method of ['GET', 'POST', 'DELETE']) {
      expect((await call(method)).status).toBe(401);
    }
    expect(mocks.getFeedToken).not.toHaveBeenCalled();
    expect(mocks.setFeedToken).not.toHaveBeenCalled();
    expect(mocks.deleteFeedToken).not.toHaveBeenCalled();
  });

  it('GET mints a token on the first ask and returns both feed URLs', async () => {
    const { status, body } = await call('GET');

    expect(status).toBe(200);
    expect(body.created).toBe(true);
    const [userId, token] = mocks.setFeedToken.mock.calls[0];
    expect(userId).toBe('u1');
    // 32 random bytes, base64url: 43 characters that survive being pasted into a calendar app.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.ics).toBe(`https://unstream.stream/feed/f/${token}.ics`);
    expect(body.atom).toBe(`https://unstream.stream/feed/f/${token}.xml`);
  });

  it('GET returns the existing token rather than minting another', async () => {
    mocks.getFeedToken.mockResolvedValue('existing-token');
    const { status, body } = await call('GET');

    expect(status).toBe(200);
    expect(body).toEqual({
      ics: 'https://unstream.stream/feed/f/existing-token.ics',
      atom: 'https://unstream.stream/feed/f/existing-token.xml',
      created: false,
    });
    expect(mocks.setFeedToken).not.toHaveBeenCalled();
  });

  it('POST replaces the token and says it rotated', async () => {
    mocks.getFeedToken.mockResolvedValue('existing-token');
    const { status, body } = await call('POST');

    expect(status).toBe(200);
    expect(body.rotated).toBe(true);
    expect(body.ics).not.toContain('existing-token');
    expect(mocks.setFeedToken).toHaveBeenCalledTimes(1);
  });

  it('DELETE revokes it', async () => {
    const { status, body } = await call('DELETE');

    expect(status).toBe(200);
    expect(body).toEqual({ revoked: true });
    expect(mocks.deleteFeedToken).toHaveBeenCalledWith('u1');
  });

  it('answers 500, never a link, when the write does not land', async () => {
    mocks.setFeedToken.mockResolvedValue(false);
    mocks.deleteFeedToken.mockResolvedValue(false);

    for (const method of ['GET', 'POST', 'DELETE']) {
      const { status, body } = await call(method);
      expect(status).toBe(500);
      expect(body.ics).toBeUndefined();
    }
  });

  it('never lets a shared cache keep an answer that carries the token', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect((await call(method)).headers['Cache-Control']).toBe('private, no-store');
    }
  });

  it('answers preflight and refuses other methods', async () => {
    expect((await handler({ httpMethod: 'OPTIONS', headers: {} })).statusCode).toBe(204);
    expect((await call('PUT')).status).toBe(405);
  });
});
