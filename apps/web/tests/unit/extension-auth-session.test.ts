// The extension's saved sign-in survives a refresh that couldn't reach Supabase.
//
// getStoredSession used to delete the stored session whenever a refresh failed for any reason, so
// opening the browser offline, or waking a laptop before Wi-Fi reconnected, signed the user out for
// good. Only Supabase rejecting the refresh token (a 4xx other than 429) ends it now. The Mac app
// applies the same rule (AuthService.refreshRejectsSession, AuthSessionRestoreTests.swift).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getStoredSession, refreshRejectsSession } from '../../../../apps/extension/lib/supabase.js';

const SESSION_KEY = 'unstream_auth_session';
const nowSeconds = () => Math.floor(Date.now() / 1000);

const expiredSession = () => ({
  access_token: 'old-access',
  refresh_token: 'old-refresh',
  expires_at: nowSeconds() - 600,
  user: { email: 'fan@example.com' },
});

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(store, items); }),
        remove: vi.fn(async (key: string) => { delete store[key]; }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const respondWith = (status: number, body: unknown = {}) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('getStoredSession with an expired access token', () => {
  it('keeps the session when the network is down', async () => {
    store[SESSION_KEY] = expiredSession();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    const session = await getStoredSession();

    expect(session?.user.email).toBe('fan@example.com');
    expect(store[SESSION_KEY]).toEqual(session);
  });

  it.each([500, 502, 503, 429])('keeps the session when Supabase answers %i', async (status) => {
    store[SESSION_KEY] = expiredSession();
    respondWith(status);

    const session = await getStoredSession();

    expect(session?.refresh_token).toBe('old-refresh');
    expect(store[SESSION_KEY]).toBeDefined();
  });

  it.each([400, 401, 403])('signs out when Supabase rejects the refresh token with %i', async (status) => {
    store[SESSION_KEY] = expiredSession();
    respondWith(status, { error_code: 'refresh_token_already_used' });

    expect(await getStoredSession()).toBeNull();
    expect(store[SESSION_KEY]).toBeUndefined();
  });

  it('stores and returns the refreshed session', async () => {
    store[SESSION_KEY] = expiredSession();
    respondWith(200, {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: nowSeconds() + 3600,
      user: { email: 'fan@example.com' },
    });

    const session = await getStoredSession();

    expect(session?.access_token).toBe('new-access');
    expect((store[SESSION_KEY] as { refresh_token: string }).refresh_token).toBe('new-refresh');
  });
});

describe('getStoredSession with a valid access token', () => {
  it('returns it without asking Supabase', async () => {
    store[SESSION_KEY] = { ...expiredSession(), expires_at: nowSeconds() + 3600 };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect((await getStoredSession())?.access_token).toBe('old-access');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('refreshRejectsSession', () => {
  it('treats only a 4xx other than rate limiting as a no', () => {
    expect(refreshRejectsSession(400)).toBe(true);
    expect(refreshRejectsSession(401)).toBe(true);
    expect(refreshRejectsSession(429)).toBe(false);
    expect(refreshRejectsSession(500)).toBe(false);
    expect(refreshRejectsSession(503)).toBe(false);
  });
});
