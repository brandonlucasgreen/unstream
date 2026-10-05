// @vitest-environment jsdom
// The Manage Tips panel before Stripe enables charges.
//
// What's worth locking: only "Stripe needs more details" offers to send the artist back to Stripe.
// While Stripe is reviewing, or after it declined, that button would be a dead end, so the panel
// says what's happening instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtistTipsPanel } from 'src/components/ArtistTipsPanel';
import type { TipSettings, TipsState } from 'src/services/tips';

function settings(state: TipsState, overrides: Partial<TipSettings> = {}): TipSettings {
  return {
    available: true,
    artistName: 'Kid Lightbulbs',
    livemode: false,
    state,
    foreignAccount: false,
    tipsEnabled: false,
    feeBasisPoints: 0,
    country: 'US',
    countries: { US: 'United States' },
    goals: [],
    totals: null,
    ...overrides,
  };
}

function renderPanel(state: TipsState, overrides: Partial<TipSettings> = {}) {
  return render(
    <MemoryRouter>
      <ArtistTipsPanel slug="kid-lightbulbs" token="t" settings={settings(state, overrides)} onChange={() => {}} />
    </MemoryRouter>
  );
}

const fetchMock = vi.fn();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ArtistTipsPanel before charges are enabled', () => {
  it('sends the artist back to Stripe when Stripe needs more details', () => {
    renderPanel('onboarding');
    expect(screen.getByText(/Stripe needs a few more details/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue on Stripe' })).toBeTruthy();
  });

  it('says Stripe is reviewing, with nothing to press', () => {
    renderPanel('stripe_review');
    expect(screen.getByText(/Stripe has your details and is checking them/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue on Stripe' })).toBeNull();
  });

  it('says Stripe declined, and points at the Stripe dashboard', () => {
    renderPanel('stripe_declined');
    expect(screen.getByText(/Stripe didn't approve this account/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Stripe dashboard/ }).getAttribute('href')).toBe('https://dashboard.stripe.com/');
    expect(screen.queryByRole('button', { name: 'Continue on Stripe' })).toBeNull();
  });
});

describe('ArtistTipsPanel when connecting fails', () => {
  it("shows a permanent Stripe rejection in the server's words, without suggesting a retry", async () => {
    fetchMock.mockResolvedValue(json(502, { error: 'Stripe can’t create accounts for this business type.', code: 'stripe_rejected' }));
    renderPanel('onboarding');
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Stripe' }));
    const message = await screen.findByText(/Stripe can’t create accounts for this business type\./);
    expect(message.textContent).toContain('support@unstream.stream');
    expect(message.textContent).not.toMatch(/try again/i);
  });

  it("shows a transient failure in the server's words, which say to try again", async () => {
    fetchMock.mockResolvedValue(json(502, { error: "Couldn't reach Stripe. Try again in a moment." }));
    renderPanel('onboarding');
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Stripe' }));
    expect(await screen.findByText("Couldn't reach Stripe. Try again in a moment.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue on Stripe' }).hasAttribute('disabled')).toBe(false);
  });

  it('says to try again when the request never reached the server', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPanel('onboarding');
    fireEvent.click(screen.getByRole('button', { name: 'Continue on Stripe' }));
    expect(await screen.findByText("Couldn't reach Stripe. Try again in a moment.")).toBeTruthy();
  });
});

describe('ArtistTipsPanel after Back from Stripe', () => {
  it('re-enables the buttons when the page is restored from the back/forward cache', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderPanel('onboarding');
    const button = screen.getByRole('button', { name: 'Continue on Stripe' });
    fireEvent.click(button);
    expect(button.hasAttribute('disabled')).toBe(true);

    const event = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(event, 'persisted', { value: true });
    act(() => { window.dispatchEvent(event); });
    expect(button.hasAttribute('disabled')).toBe(false);
  });
});

describe('ArtistTipsPanel where Stripe allows no platform fee', () => {
  it('fixes the fee at 0% and says why', () => {
    renderPanel('connected', { country: 'BR', countries: { BR: 'Brazil', US: 'United States' }, feeAllowed: false, feeBasisPoints: 300 });
    const select = screen.getByRole('combobox', { name: /Unstream's share/ }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('0');
    expect(screen.getByText("Stripe doesn't allow a platform fee on tips to accounts in Brazil, so Unstream takes nothing.")).toBeTruthy();
  });

  it('treats a missing feeAllowed as allowed', () => {
    renderPanel('connected', { feeBasisPoints: 300 });
    const select = screen.getByRole('combobox', { name: /Unstream's share/ }) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('300');
    expect(screen.getByText('Optional, and shown to fans before they pay.')).toBeTruthy();
  });
});
