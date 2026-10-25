// @vitest-environment jsdom
//
// The pending save from an unauthenticated click (audit 2026-10-25 #5). The old effect
// deleted the localStorage intent before the save ran and never looked at the outcome, so
// a failed resumed save vanished silently. These drive the real AuthProvider through the
// effect: the intent is cleared only on a confirmed save, a failure is surfaced with a
// retry, and the automatic attempt runs once per session.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { AuthProvider, useAuth } from 'src/contexts/AuthContext';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
}));

vi.mock('@sentry/react', () => ({
  captureMessage: mocks.captureMessage,
  captureException: mocks.captureException,
}));

vi.mock('src/services/auth', () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      signOut: vi.fn(),
      signInWithOtp: vi.fn(),
      signInWithPassword: vi.fn(),
    },
  }),
  waitForMagicLinkSession: vi.fn(),
}));

const session = {
  access_token: 'token-abc',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-1', email: 'fan@example.com', aud: 'authenticated', role: 'authenticated' },
};

const held: { current: ReturnType<typeof useAuth> | null } = { current: null };
function Probe() {
  const auth = useAuth();
  useEffect(() => { held.current = auth; });
  return null;
}

// This jsdom environment ships a localStorage with no working methods (the same
// brokenness behind the pre-existing AuthContext test failures), so the pending-save
// storage gets an explicit mock, in the shape AuthContext-saved-artists.test.ts uses.
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { localStorageStore[key] = value; },
  removeItem: (key: string) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
  get length() { return Object.keys(localStorageStore).length; },
  key: (i: number) => Object.keys(localStorageStore)[i] ?? null,
};

async function mountSignedIn() {
  mocks.getSession.mockResolvedValue({ data: { session } });
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(held.current?.session).toBeTruthy());
}

/** Answers the saved-artists GET and the save POST with the given outcome. */
function mockSavedArtistsFetch(saveStatus: number) {
  const postBodies: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/saved-artists') && method === 'POST') {
      postBodies.push(String(init?.body));
      if (saveStatus === 200) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          savedArtist: { artistId: body.artistId, supported: false, supportedAt: null },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'server refused' }), { status: saveStatus });
    }
    if (url.includes('/api/saved-artists')) {
      return new Response(JSON.stringify({ savedArtists: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return { postBodies };
}

function seedPendingSave(payload: unknown) {
  localStorage.setItem('pendingSave', JSON.stringify(payload));
}

describe('AuthContext — pending save from before sign-in', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock.clear();
    held.current = null;
    mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resumes the save under the canonical slug and clears the intent only on success', async () => {
    seedPendingSave({ artistId: 'bjork', artistName: 'Björk' });
    const { postBodies } = mockSavedArtistsFetch(200);

    await mountSignedIn();

    await waitFor(() => expect(postBodies.length).toBe(1));
    const body = JSON.parse(postBodies[0]);
    expect(body.artistId).toBe('bjork');
    expect(body.name).toBe('Björk');

    await waitFor(() => expect(localStorage.getItem('pendingSave')).toBeNull());
    expect(held.current?.pendingSaveFailure).toBeNull();
  });

  it('keeps the intent and exposes a retry when the save fails', async () => {
    seedPendingSave({ artistId: 'bjork', artistName: 'Björk' });
    const { postBodies } = mockSavedArtistsFetch(500);

    await mountSignedIn();

    await waitFor(() => expect(postBodies.length).toBe(1));
    expect(localStorage.getItem('pendingSave')).not.toBeNull();
    expect(held.current?.pendingSaveFailure).toEqual({ artistId: 'bjork', artistName: 'Björk' });

    // The retry re-runs the same intent; this time the server accepts it.
    mockSavedArtistsFetch(200);
    await act(async () => {
      held.current?.retryPendingSave();
    });

    await waitFor(() => expect(localStorage.getItem('pendingSave')).toBeNull());
    expect(held.current?.pendingSaveFailure).toBeNull();
  });

  it('attempts once per session, so a persisting failure cannot loop', async () => {
    seedPendingSave({ artistId: 'bjork' });
    const { postBodies } = mockSavedArtistsFetch(500);

    await mountSignedIn();
    await waitFor(() => expect(postBodies.length).toBe(1));

    // The saved-artists load settling changes saveArtist's identity, which re-runs the
    // effect — the once-per-session guard is what stops that becoming a retry loop.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(postBodies.length).toBe(1);
  });

  it('drops a corrupted intent without saving', async () => {
    localStorage.setItem('pendingSave', 'not-valid-json');
    const { postBodies } = mockSavedArtistsFetch(200);

    await mountSignedIn();

    expect(postBodies.length).toBe(0);
    expect(localStorage.getItem('pendingSave')).toBeNull();
  });
});
