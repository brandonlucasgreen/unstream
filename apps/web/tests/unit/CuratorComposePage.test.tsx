// @vitest-environment jsdom
// The curator compose page: the admin gate, adding artists, and what the two network circles
// promise.
//
// What's worth locking: the Instagram circle is the only one that means "will be tagged" — the
// Facebook one can't, because a Page mention needs a numeric Page id Unstream doesn't hold — and
// a caption the server flags as a problem blocks sending, since both posts go to Buffer as one
// all-or-nothing content item.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { CuratorComposePage } from 'src/pages/CuratorComposePage';

const auth = { isAdmin: true, session: { access_token: 'admin-token' } as { access_token: string } | null };
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(data) });

function previewFor(artists: unknown[], over: Record<string, unknown> = {}) {
  return {
    available: true,
    artists,
    missing: [],
    networks: {
      instagram: { caption: 'Tonight on Night Shift:\n\n@honeycrush – Luminaires', tags: [{ handle: 'honeycrush', x: 0.25, y: 0.3 }], untagged: [], problem: null },
      facebook: { caption: 'Tonight on Night Shift:\n\nHoneycrush – Luminaires', tags: [], untagged: ['Honeycrush'], problem: null },
    },
    ...over,
  };
}

const honeycrush = {
  slug: 'honeycrush', name: 'Honeycrush', release: 'Luminaires',
  payout: '80-85%', platform: 'Bandcamp',
  handles: { instagram: 'honeycrush', facebook: 'honeycrush' },
};

/** Route each call by URL, so a test doesn't depend on the order the page fires them in. */
function routeFetch(handlers: { suggest?: unknown; preview?: unknown; cards?: unknown; send?: unknown }) {
  mockFetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/suggest')) return ok(handlers.suggest ?? { artists: [] });
    if (url.endsWith('/preview')) return ok(handlers.preview ?? previewFor([honeycrush]));
    if (url.endsWith('/cards')) return ok(handlers.cards ?? { url: 'https://cards.unstream.stream/curator/a/b.png', altText: 'x' });
    if (url.endsWith('/send')) return ok(handlers.send ?? { results: { instagram: { postId: 'p1' } }, draft: true });
    return ok({});
  });
}

async function addHoneycrush() {
  fireEvent.change(screen.getByPlaceholderText('Add an artist…'), { target: { value: 'honey' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  fireEvent.click(await screen.findByRole('button', { name: 'Honeycrush' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockFetch.mockReset();
  auth.isAdmin = true;
  auth.session = { access_token: 'admin-token' };
  routeFetch({ suggest: { artists: [{ slug: 'honeycrush', name: 'Honeycrush', imageUrl: null }] } });
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the gate', () => {
  it('shows nothing of the tool to a non-admin', () => {
    auth.isAdmin = false;
    render(<CuratorComposePage />);
    expect(screen.getByText('Not authorized.')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add an artist…')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('adding artists', () => {
  it('starts empty and asks for someone', () => {
    render(<CuratorComposePage />);
    expect(screen.getByText(/No artists yet/)).toBeTruthy();
  });

  it('adds an artist from the typeahead and shows what we hold about them', async () => {
    render(<CuratorComposePage />);
    await addHoneycrush();

    expect(screen.getByText('Honeycrush')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Luminaires · 80-85% on Bandcamp/)).toBeTruthy());
  });

  it('does not add the same artist twice', async () => {
    render(<CuratorComposePage />);
    await addHoneycrush();
    await addHoneycrush();
    expect(screen.getAllByRole('button', { name: 'Remove Honeycrush' })).toHaveLength(1);
  });
});

describe('the network circles', () => {
  // The distinction the spec insists on: Instagram tags, Facebook does not.
  it('promises a tag on Instagram and only knowledge of the page on Facebook', async () => {
    render(<CuratorComposePage />);
    await addHoneycrush();

    await waitFor(() => expect(screen.getByTitle('Tagged as @honeycrush')).toBeTruthy());
    expect(screen.getByTitle('We have their Facebook page (not a tag)')).toBeTruthy();
  });

  it('offers a handle field for an artist with no Instagram link', async () => {
    routeFetch({
      suggest: { artists: [{ slug: 'axwax', name: 'AxWax', imageUrl: null }] },
      preview: previewFor([{ ...honeycrush, slug: 'axwax', name: 'AxWax', handles: { instagram: null, facebook: null } }]),
    });
    render(<CuratorComposePage />);
    fireEvent.change(screen.getByPlaceholderText('Add an artist…'), { target: { value: 'axwax' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.click(await screen.findByRole('button', { name: 'AxWax' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    await waitFor(() => expect(screen.getByTitle('No Instagram handle')).toBeTruthy());
    expect(screen.getByText(/AxWax — add their Instagram handle/)).toBeTruthy();
  });
});

describe('sending', () => {
  it('is blocked until there is someone to post about', () => {
    render(<CuratorComposePage />);
    expect(screen.getByRole('button', { name: 'Save as Buffer draft' }).hasAttribute('disabled')).toBe(true);
  });

  // Both networks reach Buffer as one all-or-nothing content item, so an over-long caption has
  // to stop the send rather than take the other post down with it.
  it('is blocked while the server reports a caption problem', async () => {
    routeFetch({
      suggest: { artists: [{ slug: 'honeycrush', name: 'Honeycrush', imageUrl: null }] },
      preview: previewFor([honeycrush], {
        networks: {
          instagram: { caption: 'x'.repeat(2300), tags: [], untagged: [], problem: '2300 characters, over Instagram’s 2200.' },
          facebook: { caption: 'ok', tags: [], untagged: [], problem: null },
        },
      }),
    });
    render(<CuratorComposePage />);
    await addHoneycrush();

    await waitFor(() => expect(screen.getByText(/over Instagram/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Save as Buffer draft' }).hasAttribute('disabled')).toBe(true);
  });

  it('draws a card per artist plus the cover, then sends, and reports the result', async () => {
    render(<CuratorComposePage />);
    await addHoneycrush();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as Buffer draft' }).hasAttribute('disabled')).toBe(false));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save as Buffer draft' }));
      await vi.advanceTimersByTimeAsync(100);
    });

    await waitFor(() => expect(screen.getByText('Saved to Buffer as drafts.')).toBeTruthy());

    const sendCall = mockFetch.mock.calls.find(c => (c[0] as string).endsWith('/send'));
    expect(JSON.parse((sendCall![1] as { body: string }).body).cardUrls).toHaveLength(2); // cover + one artist
  });

  it('reports a network Buffer refused without claiming it sent', async () => {
    routeFetch({
      suggest: { artists: [{ slug: 'honeycrush', name: 'Honeycrush', imageUrl: null }] },
      send: { results: { instagram: { error: 'Invalid user tag' }, facebook: { postId: 'p2' } }, draft: true },
    });
    render(<CuratorComposePage />);
    await addHoneycrush();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as Buffer draft' }).hasAttribute('disabled')).toBe(false));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save as Buffer draft' }));
      await vi.advanceTimersByTimeAsync(100);
    });

    await waitFor(() => expect(screen.getByText('Instagram: Invalid user tag')).toBeTruthy());
    expect(screen.getByText('Facebook: p2')).toBeTruthy();
  });
});
