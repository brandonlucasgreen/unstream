// @vitest-environment jsdom
// /tip/thanks: the sign-in offer comes after paying and is only ever an offer; a signed-in fan's tip
// is saved by its Checkout Session id, waiting out a webhook that hasn't landed yet; and every fan
// is told where the receipt comes from and who refunds.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const SEARCH = '?artist=kid-lightbulbs&session_id=cs_test_a1B2c3D4e5F6g7H8';
const auth = vi.hoisted(() => ({ value: { session: null as null | { access_token: string }, isLoading: false } }));
const search = vi.hoisted(() => ({ value: '' }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
  useSearchParams: () => [new URLSearchParams(search.value)],
  useLocation: () => ({ pathname: '/tip/thanks', search: search.value, hash: '' }),
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { TipThanksPage } from 'src/pages/TipThanksPage';

const fetchMock = vi.fn();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  auth.value = { session: null, isLoading: false };
  search.value = SEARCH;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('TipThanksPage', () => {
  it('offers a signed-out fan a sign-in that comes back here, and saves nothing', () => {
    render(<TipThanksPage />);
    const link = screen.getByText(/Save this tip to my account/).closest('a')!;
    expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent(`/tip/thanks${SEARCH}`)}`);
    expect(screen.getByText(/Entirely optional/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells every fan where the receipt comes from and who refunds', () => {
    render(<TipThanksPage />);
    expect(screen.getByText(/comes by email from the artist's Stripe/)).toBeTruthy();
    expect(screen.getByText('support@unstream.stream').getAttribute('href')).toBe('mailto:support@unstream.stream');
  });

  it('saves a signed-in fan’s tip by its session id', async () => {
    auth.value = { session: { access_token: 'tok' }, isLoading: false };
    fetchMock.mockResolvedValue(json(200, { status: 'saved' }));
    render(<TipThanksPage />);
    expect(await screen.findByText(/Saved to your account/)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/me/tips');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ sessionId: 'cs_test_a1B2c3D4e5F6g7H8', artistSlug: 'kid-lightbulbs' });
  });

  it('waits for the webhook when the payment isn’t recorded yet', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    auth.value = { session: { access_token: 'tok' }, isLoading: false };
    fetchMock
      .mockResolvedValueOnce(json(202, { status: 'pending' }))
      .mockResolvedValueOnce(json(200, { status: 'saved' }));
    render(<TipThanksPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await screen.findByText(/Saved to your account/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says so plainly when the tip belongs to someone else', async () => {
    auth.value = { session: { access_token: 'tok' }, isLoading: false };
    fetchMock.mockResolvedValue(json(409, { error: 'This tip is already saved to another account.' }));
    render(<TipThanksPage />);
    expect(await screen.findByText('This tip is already saved to another account.')).toBeTruthy();
  });

  it('offers nothing to save without a valid session id', () => {
    search.value = '?artist=kid-lightbulbs&session_id=not-a-session';
    auth.value = { session: { access_token: 'tok' }, isLoading: false };
    render(<TipThanksPage />);
    expect(screen.queryByText(/Save this tip/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
