// How the extension counts searches for /admin/analytics (apps/extension/lib/search-tracking.js).
// Until 2.10 every track change was a search, so an album was twelve; now a listening stretch
// with an artist is one.

import { describe, it, expect } from 'vitest';
import {
  isNewNowPlayingSearch,
  extensionBrowser,
  NOW_PLAYING_SEARCH_GAP_MS,
} from '../../../../apps/extension/lib/search-tracking.js';

const NOW = 1_800_000_000_000;

describe('isNewNowPlayingSearch', () => {
  it('counts the first artist ever detected', () => {
    expect(isNewNowPlayingSearch(undefined, 'Kid Lightbulbs', NOW)).toBe(true);
  });

  it('does not count the next track by the same artist', () => {
    const last = { artist: 'kid lightbulbs', seenAt: NOW - 4 * 60 * 1000 };
    expect(isNewNowPlayingSearch(last, 'Kid Lightbulbs', NOW)).toBe(false);
  });

  it('counts a different artist', () => {
    const last = { artist: 'kid lightbulbs', seenAt: NOW - 1000 };
    expect(isNewNowPlayingSearch(last, 'Honeycrush', NOW)).toBe(true);
  });

  it('counts the same artist again after a long gap: a new listening session', () => {
    const last = { artist: 'kid lightbulbs', seenAt: NOW - NOW_PLAYING_SEARCH_GAP_MS - 1 };
    expect(isNewNowPlayingSearch(last, 'Kid Lightbulbs', NOW)).toBe(true);
  });
});

describe('extensionBrowser', () => {
  it('recognises Firefox', () => {
    expect(extensionBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('firefox');
  });

  it('reports Chrome and other Chromium browsers as chrome', () => {
    expect(extensionBrowser('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe('chrome');
    expect(extensionBrowser('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('chrome');
  });
});
