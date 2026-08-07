// The extension's release check, driven end to end through the real service worker.
//
// The unit tests in extension-release-alerts.test.ts pin the rules; this pins the *wiring*, which
// is where all four of these defects actually lived. The rules were never wrong — the service
// worker read the singular `release` and kept four of its fields, so `offerSummary` was a field
// the popup read and nothing ever wrote, and `platforms` and `status` were dropped between the
// wire and storage. No amount of testing the helpers in isolation would have caught that.
//
// The service worker is a plain ES module with no build step, so it loads here under a stubbed
// `chrome.*` exactly as it does in the browser, and the check is triggered the way the popup
// triggers it: a CHECK_RELEASES_NOW message.

import { describe, it, expect, beforeAll, vi } from 'vitest';

type MessageHandler = (
  message: { type: string },
  sender: unknown,
  sendResponse: (value: unknown) => void
) => unknown;

const storage: Record<string, unknown> = {};
const notifications: { id: string; title: string; message: string }[] = [];
const requests: { artistName: string; platforms: Record<string, string>; sinceDays: number }[] = [];

let messageHandler: MessageHandler;

/** What the server sends for a catalogued artist: two records, one of them not out yet. */
function catalogResponse(artistName: string) {
  return {
    artistName,
    source: 'catalog',
    release: {
      releaseName: 'Infinite Normal',
      releaseDate: '2026-09-01',
      releaseUrl: 'https://unstream.stream/a/kid-lightbulbs/infinite-normal',
      platform: 'bandcamp',
    },
    releases: [
      {
        releaseName: 'Infinite Normal',
        releaseDate: '2026-09-01',
        releaseUrl: 'https://unstream.stream/a/kid-lightbulbs/infinite-normal',
        platform: 'bandcamp',
        platforms: ['bandcamp', 'mirlo'],
        status: 'announced',
        offerSummary: 'from $8 · ≈$6.80 to artist',
      },
      {
        releaseName: 'Ruined Castle',
        releaseDate: '2026-07-20',
        releaseUrl: 'https://unstream.stream/a/kid-lightbulbs/ruined-castle',
        platform: 'mirlo',
        platforms: ['mirlo'],
        status: 'released',
        offerSummary: 'Name your price',
      },
    ],
  };
}

beforeAll(async () => {
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };

  // Seeded before the module loads: it restores state at import time.
  storage.savedArtistsData = {
    'Kid Lightbulbs': {
      platforms: [
        { sourceId: 'bandcamp', url: 'https://kidlightbulbs.bandcamp.com' },
        // Deliberately a source the live-scrape fallback can't use. The old code skipped any
        // artist without bandcamp/faircamp/mirlo, which is most of the artists we hold links for.
        { sourceId: 'discogs', url: 'https://www.discogs.com/artist/1' },
      ],
    },
    'Discogs Only': {
      platforms: [{ sourceId: 'discogs', url: 'https://www.discogs.com/artist/2' }],
    },
  };
  storage.releaseCheckState = {
    // 42 days ago: a browser that was closed for six weeks.
    lastCheckDate: Date.now() - 42 * 24 * 60 * 60 * 1000,
    knownReleases: {},
    newReleases: [],
  };

  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      onMessage: {
        addListener: (handler: MessageHandler) => {
          messageHandler = handler;
        },
      },
      onInstalled: listener,
      onStartup: listener,
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    alarms: { onAlarm: listener, clear: async () => {}, create: async () => {} },
    storage: {
      local: {
        get: async (key: string | null) => {
          if (key === null) return { ...storage };
          return key in storage ? { [key]: storage[key] } : {};
        },
        set: async (values: Record<string, unknown>) => Object.assign(storage, values),
        remove: async () => {},
      },
      sync: { get: async () => ({}) },
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    notifications: {
      create: async (id: string, options: { title: string; message: string }) => {
        notifications.push({ id, title: options.title, message: options.message });
      },
      onClicked: listener,
    },
    tabs: { create: async () => {} },
    permissions: { onRemoved: listener, getAll: async () => ({ origins: [] }) },
    scripting: { getRegisteredContentScripts: async () => [] },
  };

  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (!String(url).includes('/check-releases')) {
      return { ok: true, json: async () => ({}) };
    }
    const body = JSON.parse(init?.body || '{}');
    requests.push(body);
    if (body.artistName !== 'Kid Lightbulbs') {
      // Never catalogued, and no scrapeable URL — exactly what the server returns for one.
      return { ok: false, status: 400, json: async () => ({ error: 'no platform' }) };
    }
    return { ok: true, json: async () => catalogResponse(body.artistName) };
  });

  await import('../../../../apps/extension/background/service-worker.js');

  await new Promise<void>(resolve => {
    messageHandler({ type: 'CHECK_RELEASES_NOW' }, {}, () => resolve());
  });
});

describe('the request the extension sends', () => {
  it('asks for the whole window it was asleep for', () => {
    // 43 — a hair over 42 days elapsed, rounded up — plus the 7-day padding. Without sinceDays
    // the server looks back 31 days and the rest of that gap is lost for good.
    expect(requests[0].sinceDays).toBe(50);
  });

  it('sends every link it holds, not just the three the scraper understands', () => {
    expect(requests[0].platforms).toEqual({
      bandcamp: 'https://kidlightbulbs.bandcamp.com',
      discogs: 'https://www.discogs.com/artist/1',
    });
  });

  it('still asks about an artist with no scrapeable link, since the catalogue may know them', () => {
    expect(requests.map(r => r.artistName)).toContain('Discogs Only');
  });
});

describe('what the check stores', () => {
  function stored() {
    return (storage.releaseCheckState as { newReleases: Record<string, unknown>[] }).newReleases;
  }

  it('keeps both of the artist\'s records, not just the newest', () => {
    expect(stored().map(r => r.releaseName)).toEqual(['Infinite Normal', 'Ruined Castle']);
  });

  it('persists the platform list, the status and the price summary', () => {
    const [announced, released] = stored();

    expect(announced.platforms).toEqual(['bandcamp', 'mirlo']);
    expect(announced.status).toBe('announced');
    expect(announced.offerSummary).toBe('from $8 · ≈$6.80 to artist');
    expect(released.offerSummary).toBe('Name your price');
  });

  it('marks every accepted release known, so the next check skips them all', () => {
    const known = (storage.releaseCheckState as { knownReleases: Record<string, unknown[]> })
      .knownReleases['kid lightbulbs'];

    expect(known.map((k: Record<string, unknown>) => k.releaseName)).toEqual([
      'Infinite Normal',
      'Ruined Castle',
    ]);
  });
});

describe('what the notifications say', () => {
  it('does not tell anyone a future-dated record is out now', () => {
    const announced = notifications.find(n => n.message.includes('Infinite Normal'))!;

    expect(announced.title).toBe('Kid Lightbulbs — coming soon');
    expect(announced.message).toBe(
      '"Infinite Normal" — announced for 1 September on Bandcamp and Mirlo · from $8 · ≈$6.80 to artist'
    );
  });

  it('names every platform and the price on a released record', () => {
    const released = notifications.find(n => n.message.includes('Ruined Castle'))!;

    expect(released.title).toBe('New Release from Kid Lightbulbs');
    expect(released.message).toBe('"Ruined Castle" — out now on Mirlo · Name your price');
  });
});
