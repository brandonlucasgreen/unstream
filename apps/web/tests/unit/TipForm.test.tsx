// @vitest-environment jsdom
// TipForm: a `?goal=` that isn't one of the artist's open goals starts with no goal chosen, rather
// than an invisible selection sent to checkout; and Back from Stripe (a bfcache restore) un-sticks
// "Opening Stripe…".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { TipForm } from 'src/components/TipForm';
import type { TipPageData } from 'src/services/tips';

const OPEN_GOAL = '11111111-1111-4111-8111-111111111111';
const data: TipPageData = {
  artist: { id: 'a1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: null },
  takingTips: true,
  feeBasisPoints: 0,
  goals: [{ id: OPEN_GOAL, title: 'Vinyl', targetCents: 100000, raisedCents: 0, status: 'open' }],
  presetsCents: [500, 1000, 2000],
  minCents: 300,
  maxCents: 50000,
};

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function payAndReadBody() {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 400 }));
  fireEvent.click(screen.getByRole('button', { name: /^Pay / }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe('TipForm goal from the link', () => {
  it('preselects an open goal', async () => {
    render(<TipForm data={data} initialGoalId={OPEN_GOAL} />);
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(true);
    expect((await payAndReadBody()).goalId).toBe(OPEN_GOAL);
  });

  it('ignores a goal id that is not among the open goals', async () => {
    render(<TipForm data={data} initialGoalId="22222222-2222-4222-8222-222222222222" />);
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText('No goal, just a tip')).toBeNull();
    expect((await payAndReadBody()).goalId).toBeUndefined();
  });

  it('ignores a goal id when the artist has no goals at all', async () => {
    render(<TipForm data={{ ...data, goals: [] }} initialGoalId={OPEN_GOAL} />);
    expect((await payAndReadBody()).goalId).toBeUndefined();
  });
});

describe('TipForm after Back from Stripe', () => {
  it('re-enables the pay button when the page is restored from the back/forward cache', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<TipForm data={data} />);
    fireEvent.click(screen.getByRole('button', { name: /^Pay / }));
    expect(screen.getByRole('button', { name: 'Opening Stripe…' })).toBeTruthy();

    const event = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(event, 'persisted', { value: true });
    act(() => { window.dispatchEvent(event); });
    expect(screen.getByRole('button', { name: /^Pay / }).hasAttribute('disabled')).toBe(false);
  });
});
