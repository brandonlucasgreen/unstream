// @vitest-environment jsdom
// The Promote page (release autopost): what someone the server turns away sees, connecting Buffer
// from here, the live template preview, switching on, and "Coming up" from the server's plan.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PromotePage } from 'src/services/promote';

const auth = vi.hoisted(() => ({ value: { session: { access_token: 'tok' } as null | { access_token: string }, isLoading: false } }));
const promote = vi.hoisted(() => ({ getPromotePage: vi.fn(), savePromoteSettings: vi.fn(), startBufferConnection: vi.fn() }));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
// The site header and footer have their own tests and their own data.
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('src/services/promote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/services/promote')>()),
  getPromotePage: promote.getPromotePage,
  savePromoteSettings: promote.savePromoteSettings,
  startBufferConnection: promote.startBufferConnection,
}));

import { ArtistPromotePage } from 'src/pages/ArtistPromotePage';

const loaded = (over: Partial<Extract<PromotePage, { available: true }>> = {}): PromotePage => ({
  available: true,
  artist: { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs', photoUrl: null },
  saved: true,
  settings: {
    enabled: false, enabledAt: null, postsPerWeek: null, timezone: 'America/New_York', postTime: '10:00',
    organizationId: null, channelIds: [], kindsOff: [], templates: null, pausedReason: null,
  },
  releaseCount: 20,
  recommendedPerWeek: 3,
  takesTips: false,
  previewRelease: {
    title: 'Ruined Castle', slug: 'ruined-castle', releaseType: 'ep', releaseDate: '2024-12-06', datePrecision: 'day',
    sources: [{ platform: 'bandcamp', offers: [] }],
  },
  buffer: { connected: false },
  comingUp: [{
    at: '2026-11-13T15:00:00.000Z', date: '2026-11-13', kind: 'catalogue',
    release: { title: 'Ruined Castle', slug: 'ruined-castle' }, imageUrl: null, imageOnInstagram: true,
    text: 'From the archives: Ruined Castle (2024). It’s on Bandcamp: https://unstream.stream/a/kid-lightbulbs/ruined-castle',
  }],
  recent: [],
  ...over,
});

const connected = {
  connected: true as const,
  organizations: [{ id: 'org1', name: 'Cult of Lightbulbs' }],
  organizationId: 'org1',
  channels: [
    { id: 'ig', name: 'kidlightbulbs', service: 'instagram', supported: true },
    { id: 'yt', name: 'kid lightbulbs', service: 'youtube', supported: false },
    { id: 'pin', name: 'sphmrs', service: 'pinterest', supported: false },
  ],
};

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/promote/kid-lightbulbs']}>
      <Routes>
        <Route path="/promote/:slug" element={<ArtistPromotePage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  auth.value = { session: { access_token: 'tok' }, isLoading: false };
  for (const fn of Object.values(promote)) fn.mockReset();
});
afterEach(cleanup);

describe('ArtistPromotePage', () => {
  it('says it isn’t available to someone the server turns away', async () => {
    promote.getPromotePage.mockResolvedValue({ available: false });
    renderTab();
    expect(await screen.findByText(/isn’t available on Unstream yet/)).toBeTruthy();
  });

  it('offers to connect Buffer, coming back to this page, and keeps the rest hidden until then', async () => {
    promote.getPromotePage.mockResolvedValue(loaded());
    promote.startBufferConnection.mockReturnValue(new Promise(() => {}));
    renderTab();
    const connect = await screen.findByRole('button', { name: 'Connect Buffer' });
    // Nothing about posting until there's somewhere to post.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
    expect(screen.getByText(/Once Buffer is connected with at least one channel/)).toBeTruthy();
    expect(screen.queryByText('Where it posts')).toBeNull();
    fireEvent.click(connect);
    expect(promote.startBufferConnection).toHaveBeenCalledWith('tok', 'kid-lightbulbs');
  });

  it('previews each template against the newest release as it’s edited', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    const box = await screen.findByRole('textbox', { name: 'From the archives, variant 3' });
    fireEvent.change(box, { target: { value: 'Still great: {title}' } });
    expect(screen.getByText('Still great: Ruined Castle')).toBeTruthy();
    fireEvent.change(box, { target: { value: '{titel}' } });
    expect(screen.getByText('Unknown variable {titel}')).toBeTruthy();
  });

  it('offers only the channels autopost can write for, by their networks’ proper names, and switches on straight away once one is ticked', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    promote.savePromoteSettings.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    await screen.findByRole('checkbox', { name: /kidlightbulbs · Instagram/ });
    // Networks autopost can't use aren't checkboxes at all, just named once, out of the way.
    expect(screen.queryByRole('checkbox', { name: /YouTube/ })).toBeNull();
    expect(screen.getByText(/Not available for autopost: kid lightbulbs \(YouTube\), sphmrs \(Pinterest\)\./)).toBeTruthy();

    const toggle = screen.getByRole('switch', { name: 'Autopost is off' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText('Tick at least one channel below, then switch it on.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /kidlightbulbs · Instagram/ }));
    expect(screen.getByText(/Instagram needs an image on every post/)).toBeTruthy();
    expect(screen.getByText(/nothing is saved as a draft/)).toBeTruthy();
    // The switch saves by itself; no separate Save.
    fireEvent.click(toggle);

    await waitFor(() => expect(promote.savePromoteSettings).toHaveBeenCalledWith('tok', 'kid-lightbulbs', expect.objectContaining({
      enabled: true, organizationId: 'org1', channelIds: ['ig'], postsPerWeek: null,
    })));
  });

  it('tells a new Buffer user with no accounts connected where to connect them, and checks again', async () => {
    const empty = { ...connected, channels: [] };
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: empty }));
    renderTab();
    const link = await screen.findByRole('link', { name: /Connect accounts in Buffer/ });
    expect(link.getAttribute('href')).toBe('https://publish.buffer.com/settings/channels');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(promote.getPromotePage).toHaveBeenCalledTimes(2));
  });

  it('says the same when the only accounts are ones autopost can’t post to', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: { ...connected, channels: [connected.channels[1]] } }));
    renderTab();
    expect(await screen.findByText(/None of the accounts connected in Buffer/)).toBeTruthy();
  });

  it('sets posts a week with a slider that starts on the recommendation, and stores Recommended there', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    promote.savePromoteSettings.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    const slider = await screen.findByRole('slider', { name: /Posts a week/ }) as HTMLInputElement;
    expect(slider.value).toBe('3');
    fireEvent.change(slider, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(promote.savePromoteSettings).toHaveBeenLastCalledWith('tok', 'kid-lightbulbs', expect.objectContaining({ postsPerWeek: 5 })));
    fireEvent.change(slider, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(promote.savePromoteSettings).toHaveBeenLastCalledWith('tok', 'kid-lightbulbs', expect.objectContaining({ postsPerWeek: null })));
  });

  it('offers Buffer’s queue as the recommended posting time, or a set time', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    promote.savePromoteSettings.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    fireEvent.click(await screen.findByRole('radio', { name: /Recommended: your Buffer queue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(promote.savePromoteSettings).toHaveBeenLastCalledWith('tok', 'kid-lightbulbs', expect.objectContaining({ postTime: null })));
  });

  it('labels each kind’s wording “Edit templates”', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    await screen.findByRole('textbox', { name: 'From the archives, variant 1' });
    expect(screen.getAllByText('Edit templates')).toHaveLength(7);
  });

  it('says what the switch does when it’s on', async () => {
    const base = loaded() as Extract<PromotePage, { available: true }>;
    promote.getPromotePage.mockResolvedValue(loaded({
      buffer: connected,
      settings: { ...base.settings, enabled: true, postTime: null, organizationId: 'org1', channelIds: ['ig'] },
    }));
    renderTab();
    expect(await screen.findByRole('switch', { name: 'Autopost is on' })).toBeTruthy();
    expect(screen.getByText(/Posting to 1 channel\. Each post joins your Buffer queue on its day/)).toBeTruthy();
  });

  it('shows the server’s plan under Coming up', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    const comingUp = await screen.findByRole('region', { name: 'Coming up' });
    expect(within(comingUp).getByText(/From the archives: Ruined Castle \(2024\)\. It’s on Bandcamp/)).toBeTruthy();
    // The date is in the browser's own format, so only the rest of the line is checked.
    expect(within(comingUp).getByText((_, el) => el?.tagName === 'P' && /· From the archives · Ruined Castle$/.test(el.textContent ?? ''))).toBeTruthy();
  });
});
