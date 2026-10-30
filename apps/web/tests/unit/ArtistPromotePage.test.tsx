// @vitest-environment jsdom
// The Promote page (release autopost): what someone the server turns away sees, connecting Buffer
// from here, the live template preview, switching on, and "Coming up" from the server's plan.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PromotePage, ScheduledPost } from 'src/services/promote';

type FakeSession = null | { access_token: string; user: { id: string } };
const auth = vi.hoisted(() => ({ value: { session: { access_token: 'tok', user: { id: 'u1' } } as FakeSession, isLoading: false } }));
const promote = vi.hoisted(() => ({ getPromotePage: vi.fn(), getPromoteSchedule: vi.fn(), savePromoteSettings: vi.fn(), startBufferConnection: vi.fn() }));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
// The site header and footer have their own tests and their own data.
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('src/services/promote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/services/promote')>()),
  getPromotePage: promote.getPromotePage,
  getPromoteSchedule: promote.getPromoteSchedule,
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
  today: '2026-11-11',
  comingUp: [{
    at: '2026-11-13T15:00:00.000Z', date: '2026-11-13', kind: 'catalogue',
    release: { title: 'Ruined Castle', slug: 'ruined-castle' }, imageUrl: null, imageOnInstagram: true,
    text: 'From the archives: Ruined Castle (2024). It’s on Bandcamp: https://unstream.stream/a/kid-lightbulbs/ruined-castle',
    state: { is: 'planned', toBufferAt: '2026-11-10T15:00:00.000Z', lastError: null },
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
    { id: 'tt', name: 'kidlightbulbs', service: 'tiktok', supported: true },
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
  auth.value = { session: { access_token: 'tok', user: { id: 'u1' } }, isLoading: false };
  for (const fn of Object.values(promote)) fn.mockReset();
});
afterEach(cleanup);

describe('ArtistPromotePage', () => {
  // A refreshed sign-in token is a new session object for the same person. Reloading on it sent two
  // requests at once, which could refresh the Buffer token twice and get the connection revoked.
  it('loads once per signed-in person, not again when their sign-in token refreshes', async () => {
    promote.getPromotePage.mockResolvedValue(loaded());
    const { rerender } = renderTab();
    await screen.findByRole('button', { name: 'Connect Buffer' });
    auth.value = { session: { access_token: 'tok-refreshed', user: { id: 'u1' } }, isLoading: false };
    rerender(
      <MemoryRouter initialEntries={['/promote/kid-lightbulbs']}>
        <Routes>
          <Route path="/promote/:slug" element={<ArtistPromotePage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole('button', { name: 'Connect Buffer' });
    expect(promote.getPromotePage).toHaveBeenCalledTimes(1);
  });

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
    const box = await screen.findByRole('textbox', { name: 'From the archives, template 3' });
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
    expect(screen.getByText('Not available for autopost: YouTube, Pinterest')).toBeTruthy();

    const toggle = screen.getByRole('switch', { name: 'Autopost is off' }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText('Tick at least one channel below, then switch it on.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /kidlightbulbs · Instagram/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /kidlightbulbs · TikTok/ }));
    expect(screen.getByText(/nothing is saved as a draft/)).toBeTruthy();
    // The switch saves by itself; no separate Save.
    fireEvent.click(toggle);

    await waitFor(() => expect(promote.savePromoteSettings).toHaveBeenCalledWith('tok', 'kid-lightbulbs', expect.objectContaining({
      enabled: true, organizationId: 'org1', channelIds: ['ig', 'tt'], postsPerWeek: null,
    })));
  });

  it('tells a new Buffer user with no accounts connected where to connect them, and checks again', async () => {
    const empty = { ...connected, channels: [] };
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: empty }));
    renderTab();
    const link = await screen.findByRole('link', { name: /Connect social channels in Buffer/ });
    expect(link.getAttribute('href')).toBe('https://publish.buffer.com/settings/channels');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(promote.getPromotePage).toHaveBeenCalledTimes(2));
  });

  it('says the same when the only accounts are ones autopost can’t post to', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: { ...connected, channels: connected.channels.filter(c => c.service === 'youtube') } }));
    renderTab();
    expect(await screen.findByText(/None of the channels connected in Buffer/)).toBeTruthy();
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

  it('offers Buffer’s queue (“Pick days & times for me”) as the posting time, or a set time', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    promote.savePromoteSettings.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    fireEvent.click(await screen.findByRole('radio', { name: /Pick days & times for me/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(promote.savePromoteSettings).toHaveBeenLastCalledWith('tok', 'kid-lightbulbs', expect.objectContaining({ postTime: null })));
  });

  it('labels each kind’s wording “Edit templates”', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    await screen.findByRole('textbox', { name: 'From the archives, template 1' });
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
    const status = screen.getByRole('switch', { name: 'Autopost is on' }).parentElement!;
    expect(status.textContent).toMatch(/Posting to 1 channel\. Each post lands in Buffer three days before it goes out, where you can change or delete it\. Open Buffer ↗$/);
    const open = within(status).getByRole('link', { name: 'Open Buffer ↗' });
    expect(open.getAttribute('href')).toBe('https://publish.buffer.com');
    expect(open.getAttribute('target')).toBe('_blank');
  });

  // A reconnect resumes posting by itself, so someone already connected again needs Save instead.
  it('says what starts posting again after Buffer was disconnected', async () => {
    const base = loaded() as Extract<PromotePage, { available: true }>;
    const paused = { ...base.settings, enabled: true, organizationId: 'org1', channelIds: ['ig'], pausedReason: 'buffer_disconnected' };
    promote.getPromotePage.mockResolvedValue(loaded({ settings: paused }));
    renderTab();
    expect((await screen.findByRole('alert')).textContent).toBe('Posting has stopped because Buffer was disconnected. Reconnect it to start again.');
    cleanup();

    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected, settings: paused }));
    renderTab();
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Posting stopped while Buffer was disconnected. Check where it posts, then save changes to start again.');
  });

  it('shows the server’s plan under Coming up', async () => {
    promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
    renderTab();
    const comingUp = await screen.findByRole('region', { name: 'Coming up' });
    expect(within(comingUp).getByText(/From the archives: Ruined Castle \(2024\)\. It’s on Bandcamp/)).toBeTruthy();
    // The date is in the browser's own format, so only the rest of the line is checked.
    expect(within(comingUp).getByText((_, el) => el?.tagName === 'P' && /· From the archives · Ruined Castle$/.test(el.textContent ?? ''))).toBeTruthy();
  });

  describe('where each post stands', () => {
    const on = { ...(loaded() as Extract<PromotePage, { available: true }>).settings, enabled: true, organizationId: 'org1', channelIds: ['ig'] };
    const post = (over: Partial<ScheduledPost>): ScheduledPost => ({
      at: '2026-10-30T04:00:00.000Z', date: '2026-10-30', kind: 'catalogue', release: { title: 'fruit is year 3 (honeycrush)', slug: 'fruit' },
      imageUrl: null, imageOnInstagram: true, text: 'From the archives', state: { is: 'sending' }, ...over,
    });
    /** The status chips under the posts in a region, by what each reads (its reason left off). */
    const chips = (region: HTMLElement) =>
      within(region).queryAllByRole('list', { name: 'Status' }).flatMap(list => within(list).getAllByRole('listitem'))
        .map(li => (li.textContent ?? '').split(':')[0].trim());

    it('shows each channel’s state in Buffer as a short chip, with the reason kept for the tooltip', async () => {
      promote.getPromotePage.mockResolvedValue(loaded({
        buffer: connected,
        settings: on,
        today: '2026-10-30',
        comingUp: [post({
          state: {
            is: 'in_buffer',
            skipped: 'threads: every posting time in its Buffer schedule on 2026-10-30 has passed',
            channels: [
              { channelId: 'ig', service: 'instagram', status: 'scheduled', dueAt: '2026-10-31T00:03:00.000Z', link: null, error: null },
              { channelId: 'tt', service: 'tiktok', status: 'error', dueAt: null, link: null, error: 'Video required' },
            ],
          },
        })],
        recent: [post({
          at: '2026-10-28T04:00:00.000Z', date: '2026-10-28',
          state: { is: 'in_buffer', skipped: null, channels: [{ channelId: 'ig', service: 'instagram', status: 'sent', dueAt: null, link: 'https://instagram.com/p/x', error: null }] },
        })],
      }));
      renderTab();
      const comingUp = await screen.findByRole('region', { name: 'Coming up' });
      const shown = chips(comingUp);
      expect(shown[0]).toMatch(/^Instagram · \d/);
      expect(shown.slice(1)).toEqual(['TikTok · Failed', 'Threads · Skipped']);
      expect(within(comingUp).getByTitle('Video required')).toBeTruthy();
      expect(within(comingUp).getByTitle('every posting time in its Buffer schedule on 2026-10-30 has passed')).toBeTruthy();

      const recent = screen.getByRole('region', { name: 'Recent' });
      expect(within(recent).getByRole('link', { name: 'Instagram · Posted' }).getAttribute('href')).toBe('https://instagram.com/p/x');
    });

    it('says when a post not yet in Buffer goes there, that a failed one is being retried, and that one out of tries failed', async () => {
      promote.getPromotePage.mockResolvedValue(loaded({
        buffer: connected,
        settings: on,
        today: '2026-10-30',
        comingUp: [
          post({ at: 'a', state: { is: 'planned', toBufferAt: '2099-11-10T15:00:00.000Z', lastError: null } }),
          post({ at: 'b', state: { is: 'planned', toBufferAt: '2020-01-01T00:00:00.000Z', lastError: 'Buffer 503' } }),
          post({ at: 'c', state: { is: 'failed', error: 'Buffer refused the post' } }),
        ],
      }));
      renderTab();
      const shown = chips(await screen.findByRole('region', { name: 'Coming up' }));
      expect(shown[0]).toMatch(/^To Buffer \S/);
      expect(shown.slice(1)).toEqual(['To Buffer soon', 'Retrying', 'Failed']);
    });

    it('promises nothing about Buffer while autopost is off', async () => {
      promote.getPromotePage.mockResolvedValue(loaded({ buffer: connected }));
      renderTab();
      const comingUp = await screen.findByRole('region', { name: 'Coming up' });
      expect(within(comingUp).queryByRole('list', { name: 'Status' })).toBeNull();
    });

    it('splits the four weeks into tabs with how many posts each holds, flagging one that needs a look', async () => {
      promote.getPromotePage.mockResolvedValue(loaded({
        buffer: connected,
        settings: on,
        today: '2026-10-30',
        comingUp: [
          post({ at: '1', date: '2026-10-30', text: 'Today’s post' }),
          post({ at: '2', date: '2026-11-02', text: 'Monday’s post' }),
          post({ at: '3', date: '2026-11-09', text: 'Second week', state: { is: 'failed', error: 'Buffer refused the post' } }),
          // The plan reaches 28 days out: its last day joins week four.
          post({ at: '4', date: '2026-11-27', text: 'Last day' }),
        ],
      }));
      renderTab();
      const comingUp = await screen.findByRole('region', { name: 'Coming up' });
      const tabs = within(comingUp).getAllByRole('tab');
      expect(tabs.map(t => t.getAttribute('aria-label'))).toEqual([
        'This week, 2 posts',
        expect.stringMatching(/^Week of .+, 1 post, needs a look$/),
        expect.stringMatching(/^Week of .+, 0 posts$/),
        expect.stringMatching(/^Week of .+, 1 post$/),
      ]);
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');
      expect(within(comingUp).getByText('Today’s post')).toBeTruthy();
      expect(within(comingUp).queryByText('Second week')).toBeNull();

      fireEvent.click(tabs[1]);
      expect(within(comingUp).getByText('Second week')).toBeTruthy();
      expect(within(comingUp).queryByText('Today’s post')).toBeNull();

      fireEvent.click(tabs[2]);
      expect(within(comingUp).getByText('Nothing posts this week.')).toBeTruthy();
      fireEvent.click(tabs[3]);
      expect(within(comingUp).getByText('Last day')).toBeTruthy();
    });

    it('marks the days of the open week that post', async () => {
      promote.getPromotePage.mockResolvedValue(loaded({
        buffer: connected,
        settings: on,
        today: '2026-10-30',
        comingUp: [post({ at: '1', date: '2026-10-30' }), post({ at: '2', date: '2026-11-02' })],
      }));
      renderTab();
      const days = within(await screen.findByRole('list', { name: 'Days' })).getAllByRole('listitem');
      expect(days).toHaveLength(7);
      expect(days.map(d => d.getAttribute('aria-label')!.split(': ')[1])).toEqual(['1 post', 'nothing', 'nothing', '1 post', 'nothing', 'nothing', 'nothing']);
    });

    it('reads the schedule again every two minutes while the page is in view, keeping unsaved edits and the open week', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        promote.getPromotePage.mockResolvedValue(loaded({
          buffer: connected,
          settings: on,
          today: '2026-10-30',
          comingUp: [post({ at: '1', date: '2026-10-30' }), post({ at: '2', date: '2026-11-09', text: 'Second week' })],
        }));
        promote.getPromoteSchedule.mockResolvedValue({
          pausedReason: null,
          today: '2026-10-30',
          comingUp: [post({
            at: '2', date: '2026-11-09', text: 'Second week',
            state: { is: 'in_buffer', skipped: null, channels: [{ channelId: 'ig', service: 'instagram', status: 'sent', dueAt: null, link: null, error: null }] },
          })],
          recent: [],
        });
        renderTab();
        const slider = await screen.findByRole('slider');
        fireEvent.change(slider, { target: { value: '5' } });
        const comingUp = screen.getByRole('region', { name: 'Coming up' });
        fireEvent.click(within(comingUp).getAllByRole('tab')[1]);

        vi.advanceTimersByTime(2 * 60_000);
        await waitFor(() => expect(chips(comingUp)).toEqual(['Instagram · Posted']));
        expect(promote.getPromoteSchedule).toHaveBeenCalledWith('tok', 'kid-lightbulbs');
        expect(within(comingUp).getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
        expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('5');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
