// @vitest-environment jsdom
// The Campaigns tab (/promote/:slug/campaigns): that it can connect Buffer itself, and that a
// campaign chooses its own channels rather than borrowing autopost's (Brandon, 2026-11-03).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CampaignsPage } from 'src/services/promote';

type FakeSession = null | { access_token: string; user: { id: string } };
const auth = vi.hoisted(() => ({ value: { session: { access_token: 'tok', user: { id: 'u1' } } as FakeSession, isLoading: false } }));
const promote = vi.hoisted(() => ({
  getCampaignsPage: vi.fn(),
  proposeCampaign: vi.fn(),
  campaignOverlay: vi.fn(),
  saveCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
  startBufferConnection: vi.fn(),
}));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('src/services/promote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/services/promote')>()),
  ...promote,
}));

import { PromoteCampaignsPage } from 'src/pages/PromoteCampaignsPage';

const channels = [
  { id: 'bsky', name: 'kid', service: 'bluesky', supported: true },
  { id: 'ig', name: 'kid', service: 'instagram', supported: true },
  { id: 'th', name: 'kid', service: 'threads', supported: true },
];

const release = {
  id: 'r1', title: 'Luminaires', slug: 'luminaires', releaseType: 'album', releaseDate: '2026-12-04',
  datePrecision: 'day', status: 'announced' as const, artworkUrl: null, onBandcamp: true,
  template: { title: 'Luminaires', slug: 'luminaires', releaseType: 'album', releaseDate: '2026-12-04', datePrecision: 'day', sources: [{ platform: 'bandcamp', offers: [] }] },
};

const loaded = (over: Partial<Extract<CampaignsPage, { available: true }>> = {}): CampaignsPage => ({
  available: true,
  artist: { name: 'Kid Lightbulbs', slug: 'kid-lightbulbs', photoUrl: null },
  today: '2026-11-02',
  buffer: { connected: true, organizations: [{ id: 'org-1', name: 'Kid' }], organizationId: 'org-1', channels },
  defaultChannelIds: ['bsky'],
  autopostOn: true,
  pausedReason: null,
  releases: [release],
  uploads: [],
  bandcampFridays: [],
  campaigns: [],
  ...over,
});

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/promote/kid-lightbulbs/campaigns']}>
      <Routes>
        <Route path="/promote/:slug/campaigns" element={<PromoteCampaignsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Get to the editor: pick the release, then ask for a proposal. */
async function openEditor() {
  promote.proposeCampaign.mockResolvedValue({
    posts: [{ step: 'announce', date: '2026-11-06', text: '{title} comes out {date}.', imageKey: null }],
    autopost: [],
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Next: plan posts' }));
  await screen.findByRole('heading', { name: 'Luminaires' });
}

/** The new-campaign step, as far as the channel ticks: choosing a release reveals the rest. */
async function newCampaign() {
  fireEvent.change(await screen.findByLabelText('Release'), { target: { value: 'r1' } });
  await screen.findByRole('button', { name: 'Next: plan posts' });
}

beforeEach(() => {
  auth.value = { session: { access_token: 'tok', user: { id: 'u1' } }, isLoading: false };
  for (const fn of Object.values(promote)) fn.mockReset();
});
afterEach(cleanup);

describe('PromoteCampaignsPage', () => {
  it('connects Buffer from here, coming back to this tab, for an artist who starts on it', async () => {
    promote.getCampaignsPage.mockResolvedValue(loaded({ buffer: { connected: false }, defaultChannelIds: [] }));
    promote.startBufferConnection.mockReturnValue(new Promise(() => {}));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Buffer' }));
    await waitFor(() => expect(promote.startBufferConnection).toHaveBeenCalledWith('tok', 'kid-lightbulbs', 'campaigns'));
    // No pointing at the Autopost tab to set Buffer up: this tab does it.
    expect(screen.queryByRole('link', { name: 'Autopost tab' })).toBeNull();
  });

  it('reads the other organization’s channels when there is more than one to pick from', async () => {
    const twoOrgs = {
      connected: true as const,
      organizations: [{ id: 'org-1', name: 'Kid' }, { id: 'org-2', name: 'The label' }],
      organizationId: null,
      channels: [],
    };
    promote.getCampaignsPage.mockResolvedValueOnce(loaded({ buffer: twoOrgs, defaultChannelIds: [] }));
    renderTab();
    // Nothing to tick until one is chosen, and choosing one asks the server for its channels:
    // there is no Save on this tab to reveal them.
    promote.getCampaignsPage.mockResolvedValueOnce(loaded({ buffer: { ...twoOrgs, organizationId: 'org-2', channels }, defaultChannelIds: [] }));
    fireEvent.change(await screen.findByLabelText('Buffer organization'), { target: { value: 'org-2' } });
    await waitFor(() => expect(promote.getCampaignsPage).toHaveBeenLastCalledWith('tok', 'kid-lightbulbs', 'org-2'));
    await screen.findByRole('heading', { name: 'New campaign' });
  });

  it('picks the channels on the new-campaign step, starting from autopost’s', async () => {
    promote.getCampaignsPage.mockResolvedValue(loaded());
    promote.saveCampaign.mockResolvedValue(loaded());
    renderTab();
    await newCampaign();

    // Alongside the release and the run, not inside the editor (Brandon, 2026-11-03).
    const bluesky = screen.getByLabelText(/bluesky/i) as HTMLInputElement;
    const threads = screen.getByLabelText(/threads/i) as HTMLInputElement;
    expect(bluesky.checked).toBe(true);
    expect(threads.checked).toBe(false);

    fireEvent.click(threads);
    fireEvent.click(bluesky);
    await openEditor();
    // The editor says where it posts; the control was one step back.
    expect(screen.getByText('kid · Threads')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Schedule campaign' }));
    await waitFor(() => expect(promote.saveCampaign).toHaveBeenCalled());
    expect(promote.saveCampaign.mock.calls[0][2]).toMatchObject({ channelIds: ['th'], organizationId: 'org-1' });
  });

  it('won’t plan a campaign with nowhere to post', async () => {
    promote.getCampaignsPage.mockResolvedValue(loaded());
    renderTab();
    await newCampaign();

    fireEvent.click(screen.getByLabelText(/bluesky/i));
    expect(screen.getByText('Tick at least one channel for this campaign.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next: plan posts' }) as HTMLButtonElement).disabled).toBe(true);
    expect(promote.proposeCampaign).not.toHaveBeenCalled();
  });

  it('won’t save a scheduled campaign with every channel unticked', async () => {
    // A scheduled campaign keeps its picker in the editor, so the Save guard still matters there.
    promote.getCampaignsPage.mockResolvedValue(loaded({
      campaigns: [{
        id: 'c-1', releaseId: 'r1', release: { title: 'Luminaires', artworkUrl: null }, releaseDate: '2026-12-04',
        channelIds: ['ig'],
        posts: [{ id: 'p1', step: 'announce', date: '2026-11-06', text: 'hi', imageKey: null, status: 'planned', error: null }],
        autopost: [],
      }],
    }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('heading', { name: 'Luminaires' });

    fireEvent.click(screen.getByLabelText(/instagram/i));
    expect(screen.getByText('Tick at least one channel for this campaign.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(promote.saveCampaign).not.toHaveBeenCalled();
  });

  it('edits a running campaign with the channels it was saved with', async () => {
    promote.getCampaignsPage.mockResolvedValue(loaded({
      campaigns: [{
        id: 'c-1', releaseId: 'r1', release: { title: 'Luminaires', artworkUrl: null }, releaseDate: '2026-12-04',
        channelIds: ['ig', 'th'],
        posts: [{ id: 'p1', step: 'announce', date: '2026-11-06', text: 'hi', imageKey: null, status: 'planned', error: null }],
        autopost: [],
      }],
    }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('heading', { name: 'Luminaires' });
    // A scheduled campaign has no new-campaign step to go back to, so it keeps the control.
    expect((screen.getByLabelText(/instagram/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/threads/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/bluesky/i) as HTMLInputElement).checked).toBe(false);
  });
});
