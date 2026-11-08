// @vitest-environment jsdom
// The body of /analytics/:slug: totals for the period, then the last 90 days as a list grouped by
// day. An empty list explains itself rather than vanishing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AnalyticsData } from 'src/components/ArtistAnalytics';

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 't' } }) }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

import { ArtistAnalytics } from 'src/components/ArtistAnalytics';

function answer(overrides: Partial<AnalyticsData> = {}) {
  const data: AnalyticsData = {
    artistName: 'Kid Lightbulbs',
    period: '30d',
    totals: { searches: 5, streaming: 2, views: 4, clicks: 1, releaseViews: 3 },
    fans: { saved: 2, supported: 1 },
    clicksByPlatform: { bandcamp: 1 },
    releaseViews: [{ title: 'Lightbulbs', slug: 'lightbulbs', views: 3 }],
    activity: [],
    ...overrides,
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ArtistAnalytics', () => {
  it('shows the totals, including heard while streaming and release views', async () => {
    answer();
    render(<ArtistAnalytics slug="kid-lightbulbs" />);
    expect((await screen.findAllByText('Heard while streaming')).length).toBeGreaterThan(0);
    expect(screen.getByText('Release page views')).toBeTruthy();
    // Release pages are edge-rendered, so the link is a plain anchor to the two-segment path.
    expect(screen.getByRole('link', { name: 'Lightbulbs' }).getAttribute('href')).toBe('/a/kid-lightbulbs/lightbulbs');
  });

  it('lists activity under each day', async () => {
    answer({
      activity: [
        { day: '2026-11-03', kind: 'saved', count: 1 },
        { day: '2026-11-03', kind: 'view', count: 2 },
        { day: '2026-11-01', kind: 'click', count: 1, platforms: ['bandcamp'] },
      ],
    });
    render(<ArtistAnalytics slug="kid-lightbulbs" />);
    expect(await screen.findByText('A fan saved you')).toBeTruthy();
    expect(screen.getByText('2 views of your Unstream page')).toBeTruthy();
    expect(screen.getByText('1 click through to your Bandcamp')).toBeTruthy();
    // Two days, two day headings.
    expect(screen.getAllByRole('heading', { level: 3 }).filter(h => !/Clicks|Most viewed/.test(h.textContent ?? ''))).toHaveLength(2);
  });

  it('explains an empty list instead of hiding it', async () => {
    answer({ activity: [] });
    render(<ArtistAnalytics slug="kid-lightbulbs" />);
    expect(await screen.findByText('Nothing yet in the last 90 days.')).toBeTruthy();
  });

  it('hands the artist name up for the page heading', async () => {
    answer();
    const onLoaded = vi.fn();
    render(<ArtistAnalytics slug="kid-lightbulbs" onLoaded={onLoaded} />);
    await screen.findAllByText('Heard while streaming');
    expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ artistName: 'Kid Lightbulbs' }));
  });
});
