// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const auth = vi.hoisted(() => ({ session: null as null | { access_token: string; user: { id: string } } }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: auth.session }) }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { ArtistSupportActions } from 'src/components/ArtistSupportActions';

// Each test signs in as a different user: the fan's taps are cached per user in a module store.
let userCounter = 0;
function signIn() {
  userCounter += 1;
  auth.session = { access_token: `token-${userCounter}`, user: { id: `user-${userCounter}` } };
}

const fetchMock = vi.fn();

function mineResponse(body: Record<string, unknown>) {
  return Promise.resolve(new Response(JSON.stringify({ tip: [], cities: {}, defaultCity: null, ...body })));
}

beforeEach(() => {
  auth.session = null;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ArtistSupportActions', () => {
  it('asks a signed-out fan to sign in, and sends nothing', () => {
    render(<ArtistSupportActions slug="kid-lightbulbs" artistName="Kid Lightbulbs" variant="card" />);
    fireEvent.click(screen.getByText("I'd tip them"));
    expect(screen.getByText(/to tell Kid Lightbulbs/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records "I\'d tip them" for a signed-in fan and shows it as done', async () => {
    signIn();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? Promise.resolve(new Response('{}')) : mineResponse({}));
    render(<ArtistSupportActions slug="kid-lightbulbs" artistName="Kid Lightbulbs" variant="card" />);

    fireEvent.click(screen.getByText("I'd tip them"));
    await waitFor(() => expect(screen.getByText("You'd tip them")).toBeTruthy());

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1].body)).toEqual({ slug: 'kid-lightbulbs', kind: 'tip' });
    expect(post[1].headers.Authorization).toMatch(/^Bearer token-/);
  });

  it('pre-fills Play my city from the profile location and saves it', async () => {
    signIn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response('{}'));
      if (url.includes('suggest=')) return Promise.resolve(new Response('{"suggestions":[]}'));
      return mineResponse({ defaultCity: 'Leeds' });
    });
    render(<ArtistSupportActions slug="kid-lightbulbs" artistName="Kid Lightbulbs" variant="page" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Play my city'));
    const input = await screen.findByPlaceholderText('Your city') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Leeds'));
    fireEvent.click(screen.getByText('Ask Kid Lightbulbs'));

    await waitFor(() => expect(screen.getByText('Play Leeds')).toBeTruthy());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1].body)).toEqual({ slug: 'kid-lightbulbs', kind: 'city', city: 'Leeds' });
  });

  it('shows the public counts on the page, with the claim link for an unclaimed artist', () => {
    render(
      <ArtistSupportActions
        slug="kid-lightbulbs"
        artistName="Kid Lightbulbs"
        variant="page"
        claimHref="/claim/kid-lightbulbs"
        interest={{ tipCount: 14, cities: [{ label: 'Boston', count: 12 }, { label: 'Leeds', count: 5 }] }}
      />,
    );
    expect(screen.getByText(/14 fans want to tip Kid Lightbulbs\./)).toBeTruthy();
    expect(screen.getByText('Claim your profile').getAttribute('href')).toBe('/claim/kid-lightbulbs');
    expect(screen.getByText('Most wanted in: Boston (12), Leeds (5)')).toBeTruthy();
  });

  it('shows nothing extra when no count has reached the threshold', () => {
    render(<ArtistSupportActions slug="x" artistName="X" variant="page" interest={{ tipCount: 0, cities: [] }} />);
    expect(screen.queryByText(/fans want to tip/)).toBeNull();
    expect(screen.queryByText(/Most wanted in/)).toBeNull();
  });

  it('links to the tip page instead of "I\'d tip them" when the artist takes tips', () => {
    render(<ArtistSupportActions slug="kid-lightbulbs" artistName="Kid Lightbulbs" variant="card" tipsEnabled />);
    expect(screen.getByText('Tip Kid Lightbulbs').closest('a')?.getAttribute('href')).toBe('/tip/kid-lightbulbs');
    expect(screen.queryByText("I'd tip them")).toBeNull();
  });

  it('shows open goals on the page, each linking to a tip towards it', () => {
    render(
      <ArtistSupportActions
        slug="kid-lightbulbs" artistName="Kid Lightbulbs" variant="page" tipsEnabled
        goals={[{ id: 'g1', title: 'Vinyl', targetCents: 240000, raisedCents: 120000, cityLabel: null, status: 'open' }]}
      />,
    );
    expect(screen.getByText('Vinyl').closest('a')?.getAttribute('href')).toBe('/tip/kid-lightbulbs?goal=g1');
    expect(screen.getByText('$1,200.00 of $2,400.00')).toBeTruthy();
  });
});
