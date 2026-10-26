// sendAdminPush (api/lib/ntfy.ts): the one way the backend pushes to the admin's phone.
// Callers treat `false` as "report it and carry on", so every failure has to come back as false
// rather than a throw — a throw would fail the claim an artist was submitting. And a name that
// isn't Latin-1 has to arrive intact: in a header it made fetch throw before anything was sent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendAdminPush } from '../../lib/ntfy';

const fetchMock = vi.fn();
const originalEnv = { ...process.env };
const PUSH = { title: 'Claim to review: 坂本龍一', message: 'm', tags: ['artist'], click: 'https://unstream.stream/admin/verify' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv, NTFY_SERVER_URL: 'https://ntfy.example/', NTFY_TOPIC: 'admin-alerts', NTFY_TOKEN: 'tk' };
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendAdminPush', () => {
  it('publishes the topic and a non-Latin title as JSON, with the token', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    expect(await sendAdminPush(PUSH)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ntfy.example/');
    expect(init.headers.Authorization).toBe('Bearer tk');
    expect(JSON.parse(init.body)).toEqual({ topic: 'admin-alerts', ...PUSH });
  });

  it('returns false without calling out when the token is missing', async () => {
    delete process.env.NTFY_TOKEN;

    expect(await sendAdminPush(PUSH)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when the server refuses', async () => {
    fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }));
    expect(await sendAdminPush(PUSH)).toBe(false);
  });

  it('returns false instead of throwing when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await sendAdminPush(PUSH)).toBe(false);
  });
});
