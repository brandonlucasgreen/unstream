import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError, apiRequest } from '../../src/services/api';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function reply(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
  };
}

describe('apiRequest', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends a GET with just the bearer token', async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { items: [1] }));

    const data = await apiRequest<{ items: number[] }>('tok', '/api/me/collection');

    expect(data).toEqual({ items: [1] });
    expect(mockFetch).toHaveBeenCalledWith('/api/me/collection', { headers: { Authorization: 'Bearer tok' } });
  });

  it('sends a body as JSON, with the method', async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { ok: true }));

    await apiRequest('tok', '/api/me/collection', { method: 'POST', body: { id: 'a', hidden: true } });

    expect(mockFetch).toHaveBeenCalledWith('/api/me/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: '{"id":"a","hidden":true}',
    });
  });

  it('sends a method without a body', async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { revoked: true }));

    await apiRequest('tok', '/api/me/feed-token', { method: 'DELETE' });

    expect(mockFetch).toHaveBeenCalledWith('/api/me/feed-token', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok' },
    });
  });

  // The bug this replaces: `Bearer ${session?.access_token}` went out as "Bearer undefined".
  it.each([undefined, null, ''])('refuses to send without a token (%s)', async token => {
    const error = await apiRequest(token, '/api/admin/verify').catch(e => e);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.message).toBe('Unauthorized');
  });

  it.each(['https://example.com/api/x', '//example.com/api/x', 'api/x'])(
    'refuses a path that is not on this site (%s)',
    async path => {
      await expect(apiRequest('tok', path)).rejects.toThrow('path on this site');
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("throws the server's own error, with the status and the parsed body", async () => {
    mockFetch.mockResolvedValueOnce(reply(409, { error: 'That handle is taken', code: 'taken' }));

    const error = await apiRequest('tok', '/api/me/username', { failureMessage: 'Failed to save' }).catch(e => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('That handle is taken');
    expect(error.status).toBe(409);
    expect(error.body).toEqual({ error: 'That handle is taken', code: 'taken' });
  });

  it("falls back to the caller's wording when the server gives none", async () => {
    mockFetch.mockResolvedValueOnce(reply(500, {}));
    await expect(apiRequest('tok', '/api/x', { failureMessage: 'Failed to update sharing' }))
      .rejects.toThrow('Failed to update sharing');

    mockFetch.mockResolvedValueOnce(reply(502, { error: '' }));
    await expect(apiRequest('tok', '/api/x', { failureMessage: status => `Failed to save (${status})` }))
      .rejects.toThrow('Failed to save (502)');
  });

  it('says "HTTP <status>" when nobody gave any wording', async () => {
    mockFetch.mockResolvedValueOnce(reply(503));
    await expect(apiRequest('tok', '/api/x')).rejects.toThrow('HTTP 503');
  });

  it('survives an error reply that is not JSON, or not an object', async () => {
    mockFetch.mockResolvedValueOnce(reply(502));
    const noJson = await apiRequest('tok', '/api/x').catch(e => e);
    expect(noJson.status).toBe(502);
    expect(noJson.body).toEqual({});

    mockFetch.mockResolvedValueOnce(reply(500, null));
    const nullBody = await apiRequest('tok', '/api/x').catch(e => e);
    expect(nullBody.body).toEqual({});

    // A reply object with no json() at all, as a bare `{ status: 429 }` test double has.
    mockFetch.mockResolvedValueOnce({ status: 429 });
    const bare = await apiRequest('tok', '/api/x').catch(e => e);
    expect(bare).toBeInstanceOf(ApiError);
    expect(bare.status).toBe(429);
  });

  it('answers {} for a success with no body', async () => {
    mockFetch.mockResolvedValueOnce(reply(204));
    expect(await apiRequest('tok', '/api/x', { method: 'DELETE' })).toEqual({});
  });

  it('lets a network failure through as it is', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await apiRequest('tok', '/api/x').catch(e => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});
