// @vitest-environment jsdom
// The "Tip History" list on /my-collection: hidden until there's a tip, then each with artist,
// amount and status.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

const state = vi.hoisted(() => ({ hash: '' }));
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ pathname: '/my-collection', search: '', hash: state.hash }),
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'tok' } }) }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { YourTips } from 'src/components/YourTips';

const fetchMock = vi.fn();
const tip = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', artistName: 'Kid Lightbulbs', artistSlug: 'kid-lightbulbs', amountCents: 500, paidCents: 546, refundedCents: 0,
  currency: 'usd', status: 'succeeded', goalTitle: null, createdAt: '2026-10-03T12:00:00Z', ...overrides,
});

beforeEach(() => { state.hash = ''; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/**
 * jsdom ships no IntersectionObserver, which is the path the tests above take — the component
 * falls back to asking straight away. These install one so the lazy path can be exercised, and
 * hand back the trigger that reports the section as scrolled into view.
 */
function stubObserver() {
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  class FakeObserver {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) { callbacks.push(cb); }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return () => act(() => { callbacks.forEach(cb => cb([{ isIntersecting: true }])); });
}

describe('YourTips', () => {
  it('renders nothing for a fan with no tips', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ tips: [] })));
    const { container } = render(<YourTips />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('lists each tip with the artist, the amount, what the fan paid, the goal and refunds', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ tips: [
      tip({ goalTitle: 'Vinyl' }),
      tip({ id: 't2', artistName: 'Honeycrush', artistSlug: 'honeycrush', amountCents: 1000, paidCents: 1000, status: 'refunded' }),
    ] })));
    render(<YourTips />);
    expect(await screen.findByRole('heading', { name: 'Tip History' })).toBeTruthy();
    expect(screen.getByText('Kid Lightbulbs').getAttribute('href')).toBe('/a/kid-lightbulbs');
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('you paid $5.46')).toBeTruthy();
    expect(screen.getByText(/towards “Vinyl”/)).toBeTruthy();
    expect(screen.getByText('Refunded')).toBeTruthy();
  });

  it('shows a partial refund instead of the fees line', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ tips: [tip({ refundedCents: 273 })] })));
    render(<YourTips />);
    expect(await screen.findByText('$2.73 refunded')).toBeTruthy();
    expect(screen.queryByText(/you paid/)).toBeNull();
  });

  it('shows an error rather than nothing when the list can’t load', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'boom' }), { status: 502 }));
    render(<YourTips />);
    expect(await screen.findByText(/Couldn't load your tips/)).toBeTruthy();
  });

  it('asks for nothing until the section is reached', async () => {
    const scrollIntoView = stubObserver();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ tips: [tip()] })));

    render(<YourTips />);

    // /my-collection is the signed-in home: a request here is paid on nearly every session, to
    // answer "no tips" for nearly every account.
    expect(fetchMock).not.toHaveBeenCalled();

    scrollIntoView();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('heading', { name: 'Tip History' })).toBeTruthy();
  });

  it('asks straight away when the thanks page deep-links to #tips', async () => {
    stubObserver();
    // jsdom implements no scrollIntoView, and the component jumps to the section once the tips
    // land — this is the only test that gets that far down the hash path.
    Element.prototype.scrollIntoView = vi.fn();
    state.hash = '#tips';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ tips: [tip()] })));

    render(<YourTips />);

    // Nothing to scroll to: the section hasn't rendered, so waiting for it to come into view
    // would leave the deep link pointing at nothing forever.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
