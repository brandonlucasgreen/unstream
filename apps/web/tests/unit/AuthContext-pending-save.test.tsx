// @vitest-environment jsdom
//
// A save asked for while signed out, resumed after sign-in — driven through the real AuthProvider.
//
// Audit 2026-10-25 #5: the pending save was deleted the moment it was read, so a save that
// failed after sign-in left the fan signed in, the artist unsaved, and nothing on screen to say
// so. It is now kept until the save is confirmed, and a failure is exposed for a retry.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, waitFor, cleanup, act } from '@testing-library/react';
import { AuthProvider, useAuth } from 'src/contexts/AuthContext';
import { writePendingSave, readPendingSave } from 'src/services/pendingSave';

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

// Exposes the context's save/remove so a test can call them for real. Held in an effect rather
// than assigned during render, and refreshed on every render so `api()` always sees the callbacks
// built from current state.
const held: { current: ReturnType<typeof useAuth> | null } = { current: null };
function Probe() {
  const auth = useAuth();
  useEffect(() => { held.current = auth; });
  return null;
}

function api(): ReturnType<typeof useAuth> {
  if (!held.current) throw new Error('AuthProvider is not mounted');
  return held.current;
}

// Waits on the captured context, not on a rendered proxy for it. Waiting for the DOM to say
// "signed-in" was a race: that text lands when React commits, but `held.current` is written by a
// passive effect React flushes later, and waitFor can resolve on the commit's MutationObserver
// microtask. `api()` then handed back the pre-session snapshot, whose saveArtist hits
// `if (!session) return` — so the call reported nothing and every assertion below failed.
async function mountSignedIn() {
  mocks.getSession.mockResolvedValue({ data: { session } });
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(held.current?.session).toBeTruthy());
}

function savesAnswer(status: number) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'POST') {
      return status === 200
        ? new Response(JSON.stringify({ savedArtist: { artistId: 'rodney-owl' } }), { status: 200 })
        : new Response(JSON.stringify({ error: 'boom' }), { status });
    }
    return new Response(JSON.stringify({ savedArtists: [] }), { status: 200 });
  });
}

function postedBodies(fetchSpy: ReturnType<typeof vi.spyOn>) {
  return fetchSpy.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe('AuthContext — resuming a save asked for before sign-in', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    held.current = null;
    mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  });

  it('saves under the stored key and clears it once the save is confirmed', async () => {
    writePendingSave({ artistId: 'rodney-owl', artistName: 'Rodney Owl' });
    const fetchSpy = savesAnswer(200);

    await mountSignedIn();

    await waitFor(() => expect(readPendingSave()).toBeNull());
    expect(postedBodies(fetchSpy)[0]).toMatchObject({ artistId: 'rodney-owl', name: 'Rodney Owl' });
    expect(api().failedPendingSave).toBeNull();
  });

  it('keeps the request and exposes the failure when the save fails', async () => {
    writePendingSave({ artistId: 'rodney-owl', artistName: 'Rodney Owl' });
    const fetchSpy = savesAnswer(500);

    await mountSignedIn();

    await waitFor(() => expect(api().failedPendingSave?.artistName).toBe('Rodney Owl'));
    expect(readPendingSave()?.artistId).toBe('rodney-owl');
    // Tried once, not on every re-render the rollback causes.
    expect(postedBodies(fetchSpy)).toHaveLength(1);
  });

  it('succeeds on retry and clears the failure', async () => {
    writePendingSave({ artistId: 'rodney-owl', artistName: 'Rodney Owl' });
    savesAnswer(500);
    await mountSignedIn();
    await waitFor(() => expect(api().failedPendingSave).not.toBeNull());

    vi.restoreAllMocks();
    savesAnswer(200);
    await act(async () => { await api().retryPendingSave(); });

    expect(api().failedPendingSave).toBeNull();
    expect(readPendingSave()).toBeNull();
  });

  it('drops the request when the fan dismisses it', async () => {
    writePendingSave({ artistId: 'rodney-owl' });
    savesAnswer(500);
    await mountSignedIn();
    await waitFor(() => expect(api().failedPendingSave).not.toBeNull());

    act(() => api().dismissPendingSave());

    expect(api().failedPendingSave).toBeNull();
    expect(readPendingSave()).toBeNull();
  });
});

describe('pending save storage', () => {
  beforeEach(() => localStorage.clear());

  it('clears a corrupt entry instead of retrying it forever', () => {
    localStorage.setItem('pendingSave', 'not-valid-json');
    expect(readPendingSave()).toBeNull();
    expect(localStorage.getItem('pendingSave')).toBeNull();
  });
});
