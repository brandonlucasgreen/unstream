// @vitest-environment jsdom
//
// What a failed save tells Sentry, driven through the real AuthProvider.
//
// The report itself already existed and had been firing — but it carried no status code and no
// server message, so a save that answered `400 Invalid artist slug format` on every single attempt
// was indistinguishable in Sentry from a flaky network. That is the gap these cover: the status
// code separates a client bug from an expired session from an outage, and the server's own
// explanation names the cause.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
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

// Exposes the context's save/remove so a test can call them for real. Held in an effect rather
// than assigned during render, and refreshed on every render so `api()` always sees the callbacks
// built from current state.
const held: { current: ReturnType<typeof useAuth> | null } = { current: null };
function Probe() {
  const auth = useAuth();
  useEffect(() => { held.current = auth; });
  return <div data-testid="probe">{auth.session ? 'signed-in' : 'signed-out'}</div>;
}

function api(): ReturnType<typeof useAuth> {
  if (!held.current) throw new Error('AuthProvider is not mounted');
  return held.current;
}

async function mountSignedIn() {
  mocks.getSession.mockResolvedValue({ data: { session } });
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('signed-in'));
}

/** The options passed alongside the first captureMessage call. */
function reportOptions() {
  return mocks.captureMessage.mock.calls[0][1] as {
    level: string;
    tags: Record<string, string>;
    extra: Record<string, unknown>;
  };
}

describe('AuthContext — reporting a failed save', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    held.current = null;
    mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  });

  it('puts the status code and the server\'s explanation on a rejected save', async () => {
    await mountSignedIn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid artist slug format' }), { status: 400 })
    );

    await act(async () => {
      await api().saveArtist('explosions-in-the-sky', undefined, 'Explosions in the Sky');
    });

    expect(mocks.captureMessage).toHaveBeenCalledWith('Save artist failed (rolled back)', expect.anything());
    const options = reportOptions();
    expect(options.tags.status_code).toBe('400');
    expect(options.tags.context).toBe('auth.saveArtist');
    expect(options.extra.serverError).toBe('Invalid artist slug format');
    expect(options.extra.artistId).toBe('explosions-in-the-sky');
  });

  it('distinguishes an expired session (401) from a client bug (400)', async () => {
    await mountSignedIn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })
    );

    await act(async () => {
      await api().saveArtist('radiohead', undefined, 'Radiohead');
    });

    expect(reportOptions().tags.status_code).toBe('401');
    expect(reportOptions().extra.serverError).toBe('Not authenticated');
  });

  it('survives a response with no JSON body', async () => {
    await mountSignedIn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 })
    );

    await act(async () => {
      await api().saveArtist('radiohead', undefined, 'Radiohead');
    });

    expect(reportOptions().tags.status_code).toBe('502');
    expect(reportOptions().extra.serverError).toBe('(no body)');
  });

  it('rolls the optimistic save back as well as reporting it', async () => {
    await mountSignedIn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid artist slug format' }), { status: 400 })
    );

    await act(async () => {
      await api().saveArtist('radiohead', undefined, 'Radiohead');
    });

    expect(api().isArtistSaved('radiohead')).toBe(false);
  });

  it('reports nothing when the save succeeds', async () => {
    await mountSignedIn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ savedArtist: { artistId: 'radiohead', name: 'Radiohead', slug: 'radiohead', addedAt: 'now' } }),
        { status: 200 }
      )
    );

    await act(async () => {
      await api().saveArtist('radiohead', undefined, 'Radiohead');
    });

    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(api().isArtistSaved('radiohead')).toBe(true);
  });

  it('reports a failed remove with its status code too', async () => {
    await mountSignedIn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'artistId must be an artist slug, not an id' }), { status: 400 })
    );

    await act(async () => {
      await api().removeSavedArtist('550e8400-e29b-41d4-a716-446655440000');
    });

    expect(mocks.captureMessage).toHaveBeenCalledWith('Remove artist failed (rolled back)', expect.anything());
    expect(reportOptions().tags.status_code).toBe('400');
    expect(reportOptions().extra.serverError).toBe('artistId must be an artist slug, not an id');
  });

  it('reports a failed saved-artists load with its status code', async () => {
    await mountSignedIn();

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Database not configured' }), { status: 500 })
    );

    await act(async () => {
      await api().loadSavedArtists();
    });

    expect(mocks.captureMessage).toHaveBeenCalledWith('Dashboard saved-artists load failed', expect.anything());
    expect(reportOptions().tags.status_code).toBe('500');
    expect(reportOptions().extra.serverError).toBe('Database not configured');
  });
});
