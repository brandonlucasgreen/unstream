// @vitest-environment jsdom
// /admin/analytics: the range picker drives both endpoints, the extension shows one row per
// browser, and GoatCounter being unconfigured or down never takes the search numbers with it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminAnalyticsPage } from 'src/pages/AdminAnalyticsPage';

// One object for every render, as the real context gives: the page refetches when the session
// changes, so a fresh object per render would refetch forever.
const AUTH = { isAdmin: true, isLoading: false, session: { access_token: 'admin-token' } };
vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => AUTH }));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const DASHBOARD = {
  range: { from: '2026-09-28', to: '2026-10-27', days: 30, granularity: 'day' },
  summary: { searches: 3000, searches_per_day: 100, success_rate: 80, top_platform: 'bandcamp', top_streaming_service: 'youtube' },
  chart: [{ date: '2026-10-27', searches: 100, clicks: 20, activations: 5 }],
  clients: [
    { app: 'web', browser: null, searches: 1000, clicks: 300 },
    { app: 'extension', browser: 'chrome', searches: 700, clicks: 50 },
    { app: 'extension', browser: 'firefox', searches: 200, clicks: 10 },
    { app: 'extension', browser: 'unrecorded', searches: 1100, clicks: 0 },
  ],
  search_kinds: [{ app: 'extension', typed: 100, now_playing: 800, unlabelled: 1100 }],
  platforms: [{ platform: 'bandcamp', clicks: 300 }],
  streaming_services: [{ service: 'youtube', activations: 5 }],
};

function respond(traffic: unknown, trafficStatus = 200) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).startsWith('/api/analytics/traffic')) {
      return Promise.resolve({ ok: trafficStatus === 200, status: trafficStatus, json: async () => traffic });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => DASHBOARD });
  });
}

function renderPage(path = '/admin/analytics') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AdminAnalyticsPage />
    </MemoryRouter>
  );
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

describe('AdminAnalyticsPage', () => {
  it('shows the extension per browser, and older versions on their own row', async () => {
    respond({ configured: false });
    renderPage();
    await screen.findByText('Extension · Chrome');
    expect(screen.getByText('Extension · Firefox')).not.toBeNull();
    expect(screen.getByText('Extension · browser not recorded')).not.toBeNull();
  });

  it('says GoatCounter is not connected, and still shows the search numbers', async () => {
    respond({ configured: false });
    renderPage();
    await screen.findByText(/GoatCounter isn’t connected/);
    expect(screen.getByText('3,000')).not.toBeNull();
  });

  it('shows visitors and web searches per visitor when GoatCounter answers', async () => {
    respond({
      configured: true,
      visitors: 500,
      chart: [{ date: '2026-10-27', visitors: 500 }],
      top_pages: [{ path: '/a/kid-lightbulbs', title: 'Kid Lightbulbs', visitors: 40 }],
      top_referrers: [{ name: 'Google', visitors: 90 }],
    });
    renderPage();
    await screen.findByText('/a/kid-lightbulbs');
    expect(screen.getByText('2.00')).not.toBeNull(); // 1,000 web searches / 500 visitors
    expect(screen.getByText('Google')).not.toBeNull();
  });

  it('keeps the search numbers when GoatCounter fails', async () => {
    respond({ error: 'GoatCounter did not answer', detail: 'GoatCounter /stats/total responded 401: unknown token' }, 502);
    renderPage();
    await screen.findByText(/Couldn’t load GoatCounter: GoatCounter \/stats\/total responded 401: unknown token/);
    expect(screen.getByText('Extension · Chrome')).not.toBeNull();
  });

  it('asks both endpoints for the range picked', async () => {
    respond({ configured: false });
    renderPage();
    await screen.findByText('Extension · Chrome');
    mockFetch.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '90 days' }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    for (const [url] of mockFetch.mock.calls) {
      const params = new URL(url, 'https://unstream.stream').searchParams;
      const days = (Date.parse(params.get('to')!) - Date.parse(params.get('from')!)) / 86_400_000 + 1;
      expect(days).toBe(90);
    }
  });

  it('applies a custom range from the URL', async () => {
    respond({ configured: false });
    renderPage('/admin/analytics?from=2026-06-01&to=2026-06-30');
    await screen.findByText('Extension · Chrome');
    expect(mockFetch.mock.calls[0][0]).toBe('/api/analytics/dashboard?from=2026-06-01&to=2026-06-30');
    expect(screen.getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed')).toBe('true');
  });
});
