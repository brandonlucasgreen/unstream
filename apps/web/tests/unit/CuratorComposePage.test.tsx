// @vitest-environment jsdom
// The curator compose page: the admin gate, choosing the Buffer organization and channels,
// adding artists, and what the two network circles promise.
//
// What's worth locking: the Instagram circle is the only one that means "will be tagged" — the
// Facebook one can't, because a Page mention needs a numeric Page id Unstream doesn't hold — and
// a caption the server flags as a problem blocks sending, since both posts go to Buffer as one
// all-or-nothing content item.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { CuratorComposePage } from 'src/pages/CuratorComposePage';

const auth = { session: { access_token: 'curator-token' } as { access_token: string } | null };
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

const ORGANIZATIONS = [{ id: 'org_mine', name: 'Cult of Lightbulbs' }, { id: 'org_work', name: 'Buffer' }];

const CONNECTED = {
  available: true,
  connected: true,
  organizations: ORGANIZATIONS,
  organizationId: 'org_mine',
  channels: [
    { id: 'chan_ig', name: 'nightshift', service: 'instagram', supported: true },
    { id: 'chan_fb', name: 'Night Shift', service: 'facebook', supported: true },
    { id: 'chan_ig2', name: 'otheraccount', service: 'instagram', supported: true },
    { id: 'chan_th', name: 'nightshift', service: 'threads', supported: false },
  ],
  selectedChannelIds: ['chan_ig', 'chan_fb'],
};

/** What /api/suggest really answers. The page once read `artists` from it, and so did this file. */
const suggestions = (...list: { slug: string; name: string }[]) => ({ suggestions: list.map(a => ({ imageUrl: null, ...a })) });

/** Route each call by URL, so a test doesn't depend on the order the page fires them in. */
function routeFetch(handlers: { suggest?: unknown; preview?: unknown; cards?: unknown; send?: unknown; connection?: unknown }) {
  mockFetch.mockImplementation((url: string, init?: { body?: string }) => {
    if (url === '/api/me/buffer') return ok(handlers.connection ?? CONNECTED);
    if (url === '/api/me/buffer/channels') return ok({ selectedChannelIds: JSON.parse(init!.body!).channelIds });
    if (url === '/api/me/buffer/organization') return ok({ organizationId: JSON.parse(init!.body!).organizationId });
    // Only the parameter /api/suggest actually reads; anything else gets the 400 it would.
    if (url.startsWith('/api/suggest?query=')) return ok(handlers.suggest ?? suggestions());
    if (url.startsWith('/api/suggest')) return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Query parameter is required' }) });
    if (url.endsWith('/preview')) return ok(handlers.preview ?? previewFor([honeycrush]));
    if (url.endsWith('/cards')) return ok(handlers.cards ?? { url: 'https://cards.unstream.stream/curator/a/b.png', altText: 'x' });
    if (url.endsWith('/send')) return ok(handlers.send ?? { results: { chan_ig: { service: 'instagram', name: 'nightshift', postId: 'p1' } }, draft: true });
    return ok({});
  });
}

/** Type into the artist search and pick the suggestion, the way a curator does. */
async function addArtist(typed: string, name: string) {
  // The composer only renders once the connection has loaded.
  await screen.findByPlaceholderText('Add an artist…');
  fireEvent.change(screen.getByPlaceholderText('Add an artist…'), { target: { value: typed } });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  fireEvent.mouseDown(await screen.findByRole('option', { name }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}

const addHoneycrush = () => addArtist('honey', 'Honeycrush');

/** jsdom won't navigate, so a test that needs assign() swaps location in — and must put it back. */
const realLocation = Object.getOwnPropertyDescriptor(window, 'location')!;
const stubLocation = (assign: () => void) =>
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/curator/new', pathname: '/curator/new', search: '', assign },
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.defineProperty(window, 'location', realLocation);
  mockFetch.mockReset();
  auth.session = { access_token: 'curator-token' };
  window.history.replaceState({}, '', '/curator/new');
  routeFetch({ suggest: suggestions({ slug: 'honeycrush', name: 'Honeycrush' }) });
});

afterEach(() => { cleanup(); vi.useRealTimers(); Object.defineProperty(window, 'location', realLocation); });

describe('the gate', () => {
  it('asks a signed-out visitor to sign in, and fetches nothing', () => {
    auth.session = null;
    render(<CuratorComposePage />);
    expect(screen.getByText(/Sign in to post about the artists/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add an artist…')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // The flag fails closed, so this is the normal state until it is switched on.
  it('says the feature is off when the flag is off', async () => {
    routeFetch({ connection: { available: false } });
    render(<CuratorComposePage />);
    expect(await screen.findByText(/aren’t switched on yet/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add an artist…')).toBeNull();
  });
});

describe('connecting Buffer', () => {
  // Every curator posts from their own account, so the tool is unreachable until they connect.
  it('offers to connect, and shows no composer until they have', async () => {
    routeFetch({ connection: { available: true, connected: false } });
    render(<CuratorComposePage />);

    expect(await screen.findByRole('button', { name: 'Connect Buffer' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add an artist…')).toBeNull();
  });

  it('sends them to the authorize URL Buffer gave us', async () => {
    const assign = vi.fn();
    stubLocation(assign);
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/me/buffer') return ok({ available: true, connected: false });
      if (url === '/api/me/buffer/start') return ok({ authorizeUrl: 'https://auth.buffer.com/auth?client_id=x' });
      return ok({});
    });

    render(<CuratorComposePage />);
    // The connect panel only appears once /api/me/buffer has answered.
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect Buffer' })); });

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.buffer.com/auth?client_id=x'));
  });

  it('reports what the callback said when it did not work', async () => {
    window.history.replaceState({}, '', '/curator/new?buffer=cancelled');
    routeFetch({ connection: { available: true, connected: false } });
    render(<CuratorComposePage />);

    expect(await screen.findByText('Buffer connection cancelled.')).toBeTruthy();
    // And takes it out of the URL, so a reload doesn't repeat it.
    expect(window.location.search).toBe('');
  });

  it('warns when the organization has no Instagram or Facebook channel', async () => {
    routeFetch({ connection: { ...CONNECTED, channels: [{ id: 'c', name: 'x', service: 'linkedin', supported: false }], selectedChannelIds: [] } });
    render(<CuratorComposePage />);
    expect(await screen.findByText(/Cult of Lightbulbs has no Instagram or Facebook channel/)).toBeTruthy();
  });
});

describe('choosing the organization', () => {
  // The bug: the account's first organization was taken, and it wasn't the curator's.
  it('asks which one before showing anything else, when none is chosen', async () => {
    routeFetch({ connection: { ...CONNECTED, organizationId: null, channels: [], selectedChannelIds: [] } });
    render(<CuratorComposePage />);

    expect(await screen.findByText('Choose a Buffer organization')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Add an artist…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
  });

  it('saves the one they pick, then loads its channels', async () => {
    routeFetch({ connection: { ...CONNECTED, organizationId: null, channels: [], selectedChannelIds: [] } });
    render(<CuratorComposePage />);

    fireEvent.click(await screen.findByLabelText('Buffer'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });

    const chose = mockFetch.mock.calls.find(c => c[0] === '/api/me/buffer/organization');
    expect(JSON.parse((chose![1] as { body: string }).body)).toEqual({ organizationId: 'org_work' });
    await waitFor(() => expect(mockFetch.mock.calls.filter(c => c[0] === '/api/me/buffer')).toHaveLength(2));
  });

  it('can be changed later, and cancelled without touching anything', async () => {
    render(<CuratorComposePage />);
    expect(await screen.findByText(/Buffer: Cult of Lightbulbs/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'change' }));
    expect(screen.getByText('Choose a Buffer organization')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByPlaceholderText('Add an artist…')).toBeTruthy();
    expect(mockFetch.mock.calls.some(c => c[0] === '/api/me/buffer/organization')).toBe(false);
  });

  it('offers no change link when the account has only one', async () => {
    routeFetch({ connection: { ...CONNECTED, organizations: [ORGANIZATIONS[0]] } });
    render(<CuratorComposePage />);
    await screen.findByText(/Buffer: Cult of Lightbulbs/);
    expect(screen.queryByRole('button', { name: 'change' })).toBeNull();
  });
});

describe('choosing channels', () => {
  it('lists the Instagram and Facebook channels with what is ticked, and counts the rest', async () => {
    render(<CuratorComposePage />);
    const ig = await screen.findByRole('checkbox', { name: /@nightshift/ });
    expect((ig as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /@otheraccount/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.getByText(/your other 1 Buffer channel isn’t listed/)).toBeTruthy();
  });

  it('saves a tick straight away', async () => {
    render(<CuratorComposePage />);
    const other = await screen.findByRole('checkbox', { name: /@otheraccount/ });
    await act(async () => { fireEvent.click(other); });

    const saved = mockFetch.mock.calls.find(c => c[0] === '/api/me/buffer/channels');
    expect(JSON.parse((saved![1] as { body: string }).body)).toEqual({ channelIds: ['chan_ig', 'chan_fb', 'chan_ig2'] });
  });

  // Nobody types their own handle: it's the name of the Instagram account they're posting from.
  it('signs the cards with the ticked Instagram account, with no handle field to fill', async () => {
    render(<CuratorComposePage />);
    await addHoneycrush();

    expect(screen.queryByText('Your Instagram handle')).toBeNull();
    const preview = mockFetch.mock.calls.find(c => (c[0] as string).endsWith('/preview'));
    expect(JSON.parse((preview![1] as { body: string }).body).curator.handles.instagram).toBe('nightshift');
    expect(screen.getByText(/Cards are signed @nightshift/)).toBeTruthy();
  });

  it('blocks sending while no channel is ticked', async () => {
    routeFetch({ connection: { ...CONNECTED, selectedChannelIds: [] }, suggest: suggestions({ slug: 'honeycrush', name: 'Honeycrush' }) });
    render(<CuratorComposePage />);
    await addHoneycrush();

    expect(screen.getByText(/Tick a channel under “Post to” first/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as Buffer draft' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('adding artists', () => {
  it('starts empty and asks for someone', async () => {
    render(<CuratorComposePage />);
    expect(await screen.findByText(/No artists yet/)).toBeTruthy();
  });

  // The bug: the page asked /api/suggest?q= and read `artists`, so every search came back empty.
  it('searches with the parameter /api/suggest reads', async () => {
    render(<CuratorComposePage />);
    await addHoneycrush();
    expect(mockFetch.mock.calls.some(c => c[0] === '/api/suggest?query=honey')).toBe(true);
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
      suggest: suggestions({ slug: 'axwax', name: 'AxWax' }),
      preview: previewFor([{ ...honeycrush, slug: 'axwax', name: 'AxWax', handles: { instagram: null, facebook: null } }]),
    });
    render(<CuratorComposePage />);
    await addArtist('axwax', 'AxWax');

    await waitFor(() => expect(screen.getByTitle('No Instagram handle')).toBeTruthy());
    expect(screen.getByText(/AxWax — add their Instagram handle/)).toBeTruthy();
  });
});

describe('sending', () => {
  it('is blocked until there is someone to post about', async () => {
    render(<CuratorComposePage />);
    expect((await screen.findByRole('button', { name: 'Save as Buffer draft' })).hasAttribute('disabled')).toBe(true);
  });

  // Both networks reach Buffer as one all-or-nothing content item, so an over-long caption has
  // to stop the send rather than take the other post down with it.
  it('is blocked while the server reports a caption problem', async () => {
    routeFetch({
      suggest: suggestions({ slug: 'honeycrush', name: 'Honeycrush' }),
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

  it('reports a channel Buffer refused without claiming it sent', async () => {
    routeFetch({
      suggest: suggestions({ slug: 'honeycrush', name: 'Honeycrush' }),
      send: {
        results: {
          chan_ig: { service: 'instagram', name: 'nightshift', error: 'Invalid user tag' },
          chan_fb: { service: 'facebook', name: 'Night Shift', postId: 'p2' },
        },
        draft: true,
      },
    });
    render(<CuratorComposePage />);
    await addHoneycrush();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save as Buffer draft' }).hasAttribute('disabled')).toBe(false));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save as Buffer draft' }));
      await vi.advanceTimersByTimeAsync(100);
    });

    await waitFor(() => expect(screen.getByText('Instagram @nightshift: Invalid user tag')).toBeTruthy());
    expect(screen.getByText('Facebook Night Shift: draft saved')).toBeTruthy();
  });
});
