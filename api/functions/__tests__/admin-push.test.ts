// sendAdminPush (api/functions/admin-push.ts): the one way the backend pushes to the admin's phone.
// Callers treat `false` as "report it and carry on", so every failure has to come back as false
// rather than a throw — a throw would fail the claim an artist was submitting. Names that aren't
// Latin-1 have to arrive intact, and an over-long one must not get the push rejected outright.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendAdminPush } from '../admin-push';

const fetchMock = vi.fn();
const originalEnv = { ...process.env };
const PUSH = { title: 'Claim to review: 坂本龍一', message: 'm', url: 'https://unstream.stream/admin/verify' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv, PUSHOVER_APP_TOKEN: 'app-token', PUSHOVER_USER_KEY: 'user-key' };
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendAdminPush', () => {
  it('sends the app token, user key and a non-Latin title to Pushover as JSON', async () => {
    fetchMock.mockResolvedValue(new Response('{"status":1}', { status: 200 }));

    expect(await sendAdminPush(PUSH)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(JSON.parse(init.body)).toMatchObject({
      token: 'app-token',
      user: 'user-key',
      title: 'Claim to review: 坂本龍一',
      message: 'm',
      url: 'https://unstream.stream/admin/verify',
    });
  });

  it('trims a title and message to the lengths Pushover accepts', async () => {
    fetchMock.mockResolvedValue(new Response('{"status":1}', { status: 200 }));

    await sendAdminPush({ ...PUSH, title: 'x'.repeat(300), message: 'y'.repeat(2000) });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.title).toHaveLength(250);
    expect(sent.message).toHaveLength(1024);
  });

  it('returns false without calling out when the user key is missing', async () => {
    delete process.env.PUSHOVER_USER_KEY;

    expect(await sendAdminPush(PUSH)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false and logs the reason when Pushover refuses', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"status":0,"errors":["application token is invalid"]}', { status: 400 })
    );

    expect(await sendAdminPush(PUSH)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('application token is invalid'));
  });

  it('returns false instead of throwing when Pushover is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await sendAdminPush(PUSH)).toBe(false);
  });
});
