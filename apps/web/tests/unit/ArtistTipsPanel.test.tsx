// @vitest-environment jsdom
// The Manage Tips panel before Stripe enables charges.
//
// What's worth locking: only "Stripe needs more details" offers to send the artist back to Stripe.
// While Stripe is reviewing, or after it declined, that button would be a dead end, so the panel
// says what's happening instead.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ArtistTipsPanel } from 'src/components/ArtistTipsPanel';
import type { TipSettings, TipsState } from 'src/services/tips';

function settings(state: TipsState): TipSettings {
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
  };
}

function renderPanel(state: TipsState) {
  return render(
    <MemoryRouter>
      <ArtistTipsPanel slug="kid-lightbulbs" token="t" settings={settings(state)} onChange={() => {}} />
    </MemoryRouter>
  );
}

afterEach(cleanup);

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
