// @vitest-environment jsdom
// The Manage Tips page: a signed-out artist is sent to sign in and brought back here; Stripe's
// `?stripe=refresh` (the onboarding link expired) fetches a fresh link and goes straight back, once;
// `?stripe=return` says so; and both leave the address clean.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { TipSettings, TipsState } from 'src/services/tips';

const auth = vi.hoisted(() => ({ value: { session: null as null | { access_token: string }, isLoading: false } }));
const tips = vi.hoisted(() => ({ getTipSettings: vi.fn(), connectStripe: vi.fn() }));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('src/components/ArtistTipsPanel', () => ({
  ArtistTipsPanel: ({ settings }: { settings: TipSettings }) => <div data-testid="panel">{settings.state}</div>,
}));
vi.mock('src/services/tips', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/services/tips')>()),
  getTipSettings: tips.getTipSettings,
  connectStripe: tips.connectStripe,
}));

import { ArtistTipsPage } from 'src/pages/ArtistTipsPage';

function settings(state: TipsState): TipSettings {
  return {
    available: true, artistName: 'Kid Lightbulbs', livemode: false, state, foreignAccount: false,
    tipsEnabled: false, feeBasisPoints: 0, country: 'US', countries: { US: 'United States' }, goals: [], totals: null,
  };
}

let location: { pathname: string; search: string } | null = null;
function LocationProbe() {
  location = useLocation();
  return null;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/artist-edit/:slug/tips" element={<ArtistTipsPage />} />
        <Route path="/login" element={<p>login page</p>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

beforeEach(() => {
  auth.value = { session: { access_token: 'tok' }, isLoading: false };
  tips.getTipSettings.mockReset();
  tips.connectStripe.mockReset();
  location = null;
});
afterEach(cleanup);

describe('ArtistTipsPage', () => {
  it('sends a signed-out visitor to sign in, coming back to this tab', async () => {
    auth.value = { session: null, isLoading: false };
    renderAt('/artist-edit/kid-lightbulbs/tips');
    await screen.findByText('login page');
    expect(location!.pathname).toBe('/login');
    expect(new URLSearchParams(location!.search).get('next')).toBe('/artist-edit/kid-lightbulbs/tips');
  });

  it('after an expired Stripe link, fetches a fresh one and goes back to Stripe, once', async () => {
    tips.getTipSettings.mockResolvedValue(settings('onboarding'));
    tips.connectStripe.mockReturnValue(new Promise(() => {}));
    renderAt('/artist-edit/kid-lightbulbs/tips?stripe=refresh');
    expect(await screen.findByText('Taking you back to Stripe…')).toBeTruthy();
    expect(tips.connectStripe).toHaveBeenCalledTimes(1);
    expect(tips.connectStripe).toHaveBeenCalledWith('tok', 'kid-lightbulbs', {});
    await waitFor(() => expect(location!.search).toBe(''));
    expect(tips.connectStripe).toHaveBeenCalledTimes(1);
  });

  it('shows the panel and an error when a fresh link can’t be had', async () => {
    tips.getTipSettings.mockResolvedValue(settings('onboarding'));
    tips.connectStripe.mockRejectedValue(new TypeError('Failed to fetch'));
    renderAt('/artist-edit/kid-lightbulbs/tips?stripe=refresh');
    expect(await screen.findByText(/Stripe's link had expired and we couldn't get a new one/)).toBeTruthy();
    expect(screen.getByTestId('panel')).toBeTruthy();
    expect(screen.queryByText('Taking you back to Stripe…')).toBeNull();
    expect(tips.connectStripe).toHaveBeenCalledTimes(1);
  });

  it("doesn't go back to Stripe for an artist past onboarding", async () => {
    tips.getTipSettings.mockResolvedValue(settings('stripe_review'));
    renderAt('/artist-edit/kid-lightbulbs/tips?stripe=refresh');
    expect(await screen.findByTestId('panel')).toBeTruthy();
    expect(tips.connectStripe).not.toHaveBeenCalled();
  });

  it('confirms the return from Stripe and cleans up the address', async () => {
    tips.getTipSettings.mockResolvedValue(settings('stripe_review'));
    renderAt('/artist-edit/kid-lightbulbs/tips?stripe=return');
    expect(await screen.findByText("Back from Stripe. Here's where things stand.")).toBeTruthy();
    expect(screen.getByTestId('panel')).toBeTruthy();
    expect(location!.search).toBe('');
    expect(tips.connectStripe).not.toHaveBeenCalled();
  });

  it('shows the disconnected state as not connected, with no Stripe banner', async () => {
    tips.getTipSettings.mockResolvedValue(settings('not_connected'));
    renderAt('/artist-edit/kid-lightbulbs/tips');
    expect((await screen.findByTestId('panel')).textContent).toBe('not_connected');
    expect(screen.queryByText(/Back from Stripe/)).toBeNull();
  });
});
