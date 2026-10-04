import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handler } from '../discord-search-background';

// Every function is publicly reachable at /.netlify/functions/<name>. This one used to run a
// full search and PATCH Discord with the bot token for anyone who POSTed to it, at a path
// built from ids in the body (so `../` in them aimed the bot token at other API routes).

const SECRET = 'test-internal-secret';

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    application_id: '123456789012345678',
    interaction_token: 'aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDEyMzQ1Njc4',
    artist_name: 'Kid Lightbulbs',
    ...overrides,
  });
}

describe('discord-search-background', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv('INTERNAL_FUNCTION_SECRET', SECRET);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('refuses a call without the internal secret, before fetching anything', async () => {
    const res = await handler({ body: body(), headers: {} });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a call with the wrong secret', async () => {
    const res = await handler({ body: body(), headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a token with a path traversal', { interaction_token: 'x/../../../channels/1/messages/2?' }],
    ['a dot segment as the token', { interaction_token: '..' }],
    ['a non-numeric application id', { application_id: '../channels' }],
  ])('rejects %s', async (_label, overrides) => {
    const res = await handler({
      body: body(overrides),
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
