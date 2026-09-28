// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
  useParams: () => ({ slug: 'kid-lightbulbs' }),
  useSearchParams: () => [new URLSearchParams('')],
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { TipPage } from 'src/pages/TipPage';

const fetchMock = vi.fn();
const page = (overrides: Record<string, unknown> = {}) => ({
  artist: { id: 'a1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: null },
  takingTips: true, feeBasisPoints: 0, goals: [], presetsCents: [500, 1000, 2000], minCents: 300, maxCents: 50000,
  ...overrides,
});

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('TipPage', () => {
  it('shows the breakdown before paying, fees covered by default', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(page())));
    render(<TipPage />);
    fireEvent.click(await screen.findByText('$5'));
    // "You pay $5.46 · Stripe keeps $0.46 · Unstream keeps $0 · {Artist} gets $5.00" (spec §5)
    expect(screen.getByText('$5.46')).toBeTruthy();
    expect(screen.getByText(/Stripe keeps ~\$0\.46/)).toBeTruthy();
    expect(screen.getByText(/Unstream keeps \$0\.00/)).toBeTruthy();
    expect(screen.getByText(/Kid Lightbulbs gets ~\$5\.00/)).toBeTruthy();
    expect(screen.getByText('Pay $5.46 with Stripe')).toBeTruthy();
  });

  it('sends only the amount, the checkbox and the goal', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(page())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://checkout.stripe.com/x' })));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, set href(v: string) { assign(v); } });
    render(<TipPage />);
    fireEvent.click(await screen.findByText('$10'));
    fireEvent.click(screen.getByLabelText(/Cover the fees/));
    fireEvent.click(screen.getByText('Pay $10.00 with Stripe'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/x'));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ artistSlug: 'kid-lightbulbs', amountCents: 1000, coverFees: false });
  });

  it('refuses a custom amount under $3', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(page())));
    render(<TipPage />);
    fireEvent.change(await screen.findByLabelText(/Other amount/), { target: { value: '1' } });
    expect(screen.getByText(/Tips are between \$3\.00 and \$500\.00/)).toBeTruthy();
    expect((screen.getByText('Pay with Stripe') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the goal is unconditional', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(page({
      goals: [{ id: 'g1', title: 'Vinyl', targetCents: 240000, raisedCents: 1000, status: 'open' }],
    }))));
    render(<TipPage />);
    expect(await screen.findByText(/Tips go to Kid Lightbulbs straight away, whether or not the goal is met\./)).toBeTruthy();
  });

  it('says so for an artist not taking tips, and points to their page', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ artist: page().artist, takingTips: false })));
    render(<TipPage />);
    expect(await screen.findByText(/isn't taking tips on Unstream yet/)).toBeTruthy();
    expect(screen.getByText(/See where else to support them/).getAttribute('href')).toBe('/a/kid-lightbulbs');
    expect(screen.queryByText(/Pay/)).toBeNull();
  });
});
