// How the extension counts searches for /admin/analytics.
//
// A search is either typed (the popup's search box, or a saved artist's name) or now playing
// (a streaming tab told us who is playing). The Mac app makes the same split, and both send it
// as `search_kind` so the dashboard can show the two apart.
//
// Now-playing searches are counted once per listening stretch with an artist, not per track.
// Until extension 2.10 every track change — and every pause and resume — wrote a `search`
// event, so a 12-track album was 12 searches and the extension's line in the dashboard dwarfed
// every other client's. That was a count of songs played, not of artists looked up.

export const LAST_NOW_PLAYING_SEARCH_KEY = 'lastNowPlayingSearch';

// The same artist heard again after this long without being heard is a new search: a new
// listening session, not the next track of the same one.
export const NOW_PLAYING_SEARCH_GAP_MS = 30 * 60 * 1000;

/**
 * Whether a now-playing detection of `artist` counts as a new search.
 *
 * @param {{ artist: string, seenAt: number } | undefined} last the artist last detected and when
 * @param {string} artist
 * @param {number} now
 * @returns {boolean}
 */
export function isNewNowPlayingSearch(last, artist, now) {
  if (!last || last.artist !== artist.toLowerCase()) return true;
  return now - last.seenAt > NOW_PLAYING_SEARCH_GAP_MS;
}

/**
 * Which browser this extension build is running in. Edge, Brave and the other Chromium browsers
 * install the Chrome build and report as 'chrome'.
 *
 * @param {string} userAgent
 * @returns {'chrome' | 'firefox'}
 */
export function extensionBrowser(userAgent) {
  return /\bFirefox\//.test(userAgent) ? 'firefox' : 'chrome';
}
