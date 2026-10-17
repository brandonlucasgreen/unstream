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
import { TIP_FAQ_ANCHOR } from 'src/data/faq';
import type { TipPageData } from 'src/services/tips';

// UNS-219: "How tipping works" links to the tipping question in the FAQ (stable anchor exported
// from faq.ts, so removing the question fails this file's import rather than stranding the link).

const OPEN_GOAL = '11111111-1111-4111-8111-111111111111';
const data: TipPageData = {
  artist: { id: 'a1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: null },
  takingTips: true,
  feeBasisPoints: 0,
  goals: [{ id: OPEN_GOAL, title: 'Vinyl', targetCents: 100000, raisedCents: 0, status: 'open' }],
  presetsCents: [300, 500, 1000],
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

describe('TipForm "How tipping works" link', () => {
  it('points at the tipping question in the FAQ, not the terms of use', () => {
    render(<TipForm data={data} />);
    const link = screen.getByText('How tipping works').closest('a')!;
    expect(link.getAttribute('href')).toBe(`/faq#${TIP_FAQ_ANCHOR}`); // /faq#tipping
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

// UNS-218: the preset amounts moved to $3 / $5 / $10, and $5 is the default selection.
describe('TipForm presets', () => {
  it('offers $3, $5 and $10 and opens with $5 selected', async () => {
    render(<TipForm data={data} />);
    for (const label of ['$3', '$5', '$10']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '$5' }).getAttribute('aria-pressed')).toBe('true');
    expect((await payAndReadBody()).amountCents).toBe(500);
  });

  it('falls back to the shared presets when the server sent none', () => {
    render(<TipForm data={{ ...data, presetsCents: undefined }} />);
    for (const label of ['$3', '$5', '$10']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: '$20' })).toBeNull();
  });
});
