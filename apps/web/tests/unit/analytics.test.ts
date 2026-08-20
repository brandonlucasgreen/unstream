// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { analytics } from '../../src/services/analytics';

/**
 * These guard one specific outage: search hanging forever in private windows.
 *
 * index.html sets `window.goatcounter` to a settings object before count.js loads, so the object
 * is always there and only `count` is missing when count.js is blocked. `window.goatcounter?.count(…)`
 * therefore stopped short-circuiting and started throwing, and because App.tsx calls
 * analytics.trackSearch() just above the try block around the search, the throw escaped the
 * handler after setIsLoading(true) — no request was made and the skeletons never resolved.
 *
 * The rule these encode: an analytics call never throws, whatever shape window.goatcounter is in.
 */
describe('analytics — never throws, whatever GoatCounter is doing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as { goatcounter?: unknown }).goatcounter;
    // trackAppEvent POSTs fire-and-forget; stub it so these tests never touch the network.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 204 })));
  });

  it('survives a settings object with no count (count.js blocked — the regression)', () => {
    window.goatcounter = { path: () => location.pathname };

    expect(() => analytics.trackSearch()).not.toThrow();
    expect(() => analytics.trackPlatformClick('bandcamp')).not.toThrow();
    expect(() => analytics.trackArtistPageView('some-artist')).not.toThrow();
    expect(() => analytics.trackDownload()).not.toThrow();
  });

  it('survives GoatCounter being absent entirely', () => {
    expect(() => analytics.trackSearch()).not.toThrow();
    expect(() => analytics.trackArtistLinkClick('some-artist', 'mirlo')).not.toThrow();
  });

  it('survives count() itself throwing', () => {
    window.goatcounter = { count: () => { throw new Error('blocked mid-call'); } };

    expect(() => analytics.trackSearch()).not.toThrow();
  });

  it('still reports the event when GoatCounter is loaded normally', () => {
    const count = vi.fn();
    window.goatcounter = { count };

    analytics.trackSearch();

    expect(count).toHaveBeenCalledWith({ path: '/search', event: true });
  });
});

/**
 * These pin the write-side of the Disk IO fixes (2026-08-19): one product event per user action,
 * and search appearances batched into one request per burst instead of one per rendered card.
 * Every fetch here is a Postgres write on the other end.
 */
describe('analytics — one write per user action', () => {
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 204 }));

  const appEventCalls = (type: string) =>
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === '/api/analytics/app-event' &&
        JSON.parse((init as RequestInit).body as string).event_type === type
    );

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    fetchMock.mockClear();
    delete (window as { goatcounter?: unknown }).goatcounter;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('records a search once, on completion — initiation is GoatCounter-only', () => {
    analytics.trackSearch();
    analytics.trackSearchResults(true, 7);

    const searchEvents = appEventCalls('search');
    expect(searchEvents).toHaveLength(1);
    expect(JSON.parse((searchEvents[0][1] as RequestInit).body as string).context).toMatchObject({
      has_results: true,
      result_count: 7,
    });
  });

  it('records one platform_click per claimed link click', () => {
    analytics.trackArtistLinkClick('some-artist', 'mirlo');

    expect(appEventCalls('platform_click')).toHaveLength(1);
  });

  it('batches a burst of search appearances into a single deduplicated request', () => {
    analytics.trackArtistSearchAppearance('artist-a');
    analytics.trackArtistSearchAppearance('artist-b');
    analytics.trackArtistSearchAppearance('artist-a'); // a re-render must not double-count

    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/analytics/event')).toHaveLength(0);
    vi.runAllTimers();

    const eventCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/analytics/event');
    expect(eventCalls).toHaveLength(1);
    expect(JSON.parse((eventCalls[0][1] as RequestInit).body as string)).toEqual({
      slugs: ['artist-a', 'artist-b'],
      metric: 'search',
    });
  });

  it('starts a fresh batch for appearances that land after a flush (enrichment results)', () => {
    analytics.trackArtistSearchAppearance('artist-a');
    vi.runAllTimers();
    analytics.trackArtistSearchAppearance('artist-c');
    vi.runAllTimers();

    const eventCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/analytics/event');
    expect(eventCalls).toHaveLength(2);
    expect(JSON.parse((eventCalls[1][1] as RequestInit).body as string).slugs).toEqual(['artist-c']);
  });
});
