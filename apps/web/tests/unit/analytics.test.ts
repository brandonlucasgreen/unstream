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
