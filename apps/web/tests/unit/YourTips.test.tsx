// @vitest-environment jsdom
// The Settings "Your tips" list: hidden until there's a tip, then each with artist, amount and status.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ pathname: '/settings', search: '', hash: '' }),
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'tok' } }) }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { YourTips } from 'src/components/YourTips';

const fetchMock = vi.fn();
const tip = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', artistName: 'Kid Lightbulbs', artistSlug: 'kid-lightbulbs', amountCents: 500, paidCents: 546,
  currency: 'usd', status: 'succeeded', goalTitle: null, createdAt: '2026-10-03T12:00:00Z', ...overrides,
});

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
    expect(await screen.findByRole('heading', { name: 'Your tips' })).toBeTruthy();
    expect(screen.getByText('Kid Lightbulbs').getAttribute('href')).toBe('/a/kid-lightbulbs');
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('you paid $5.46')).toBeTruthy();
    expect(screen.getByText(/towards “Vinyl”/)).toBeTruthy();
    expect(screen.getByText('Refunded')).toBeTruthy();
  });

  it('shows an error rather than nothing when the list can’t load', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'boom' }), { status: 502 }));
    render(<YourTips />);
    expect(await screen.findByText(/Couldn't load your tips/)).toBeTruthy();
  });
});
