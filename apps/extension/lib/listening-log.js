// Play counts: how many times each artist was played in this browser, and how often their links
// were opened from the popup, per calendar month. Kept in chrome.storage.local and never sent
// anywhere. It exists so a future year-end recap can say who someone actually listened to
// (docs/specs/unwrapped-spec.md §4). The Mac app keeps the same log in the same shape
// (apps/mac/Unstream/Models/ListeningLog.swift); change the two together.
//
// What's stored, and nothing more: per month, per artist, a display name, a play count and a
// click count. No track titles, albums, timestamps, sites or URLs.
//
// What counts as a play: a track that was playing for at least 30 seconds before the next track
// started or playback stopped. Content scripts only report changes (a new track, or stopped), so
// the time is measured at the next change rather than with a timer, which suits a service worker
// that may be asleep in between. A track the browser was closed during is never counted; that
// costs one play now and then, and a timer that survives the worker sleeping would cost far more.
//
// On by default; the Settings tab turns it off, and turning it off deletes what was stored.

export const LISTENING_LOG_KEY = 'listeningLog';
export const LISTENING_TRACK_KEY = 'listeningTrack';
export const PLAY_COUNTING_KEY = 'playCounting';
export const PLAY_COUNTING_NOTICE_KEY = 'playCountingNoticeSeen';

export const MIN_PLAY_MS = 30 * 1000;
// Pausing and resuming a track reports it twice. A track already counted in the last ten minutes
// isn't counted again, so a pause in the middle of a song is still one play.
export const REPEAT_GUARD_MS = 10 * 60 * 1000;
export const MAX_MONTHS = 24;
export const MAX_ARTISTS_PER_MONTH = 2000;

/** @typedef {{ name: string, plays: number, clicks: number }} ArtistCounts */
/** @typedef {{ v: 1, months: Record<string, Record<string, ArtistCounts>> }} ListeningLog */
/** @typedef {{ current: { key: string, artist: string, startedAt: number } | null, lastCounted: { key: string, at: number } | null }} TrackState */

/** @returns {ListeningLog} */
export function emptyLog() {
  return { v: 1, months: {} };
}

/** @returns {TrackState} */
export function emptyTrackState() {
  return { current: null, lastCounted: null };
}

export function isPlayCountingOn(storedValue) {
  return storedValue !== false;
}

export function artistKey(name) {
  return name.trim().toLowerCase();
}

/** 'YYYY-MM' in the browser's own time zone, so December means the listener's December. */
export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthIndex(key) {
  const [year, month] = key.split('-').map(Number);
  return year * 12 + (month - 1);
}

function isLog(value) {
  return Boolean(value) && value.v === 1 && typeof value.months === 'object' && value.months !== null;
}

/**
 * Add one play or one click for an artist in the month `now` falls in.
 *
 * @param {ListeningLog | undefined} log
 * @param {string} artistName
 * @param {'plays' | 'clicks'} field
 * @param {number} now
 * @returns {ListeningLog}
 */
export function addToLog(log, artistName, field, now) {
  const base = isLog(log) ? log : emptyLog();
  const name = typeof artistName === 'string' ? artistName.trim() : '';
  if (!name) return base;

  const month = monthKey(now);
  const entries = { ...(base.months[month] || {}) };
  const key = artistKey(name);
  const previous = entries[key] || { name, plays: 0, clicks: 0 };
  entries[key] = { ...previous, [field]: previous[field] + 1 };

  return pruneLog({ v: 1, months: { ...base.months, [month]: capMonth(entries) } }, now);
}

/** Keep the most-heard artists when a month grows past the cap. */
function capMonth(entries) {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ARTISTS_PER_MONTH) return entries;
  const kept = keys
    .sort((a, b) => (entries[b].plays + entries[b].clicks) - (entries[a].plays + entries[a].clicks))
    .slice(0, MAX_ARTISTS_PER_MONTH);
  return Object.fromEntries(kept.map(key => [key, entries[key]]));
}

/** Drop months more than MAX_MONTHS before the month `now` falls in. */
export function pruneLog(log, now) {
  const newest = monthIndex(monthKey(now));
  const months = Object.fromEntries(
    Object.entries(log.months).filter(([key]) => newest - monthIndex(key) < MAX_MONTHS)
  );
  return { v: 1, months };
}

/**
 * Totals for one calendar year, for the Settings tab.
 *
 * @param {ListeningLog | undefined} log
 * @param {number} year
 * @returns {{ plays: number, clicks: number, artists: number }}
 */
export function yearTotals(log, year) {
  if (!isLog(log)) return { plays: 0, clicks: 0, artists: 0 };
  let plays = 0;
  let clicks = 0;
  const artists = new Set();
  for (const [month, entries] of Object.entries(log.months)) {
    if (!month.startsWith(`${year}-`)) continue;
    for (const [key, counts] of Object.entries(entries)) {
      plays += counts.plays;
      clicks += counts.clicks;
      artists.add(key);
    }
  }
  return { plays, clicks, artists: artists.size };
}

function trackKey(artist, title) {
  return `${artistKey(artist)}\u0000${(title || '').trim().toLowerCase()}`;
}

/**
 * Close the track that was playing. Returns the artist to count a play for, or null.
 *
 * @param {TrackState | undefined} state
 * @param {number} now
 * @returns {{ state: TrackState, countedArtist: string | null }}
 */
export function playbackStopped(state, now) {
  const { current, lastCounted } = state || emptyTrackState();
  if (!current) return { state: { current: null, lastCounted: lastCounted ?? null }, countedArtist: null };

  const playedLongEnough = now - current.startedAt >= MIN_PLAY_MS;
  const countedRecently = Boolean(lastCounted)
    && lastCounted.key === current.key
    && now - lastCounted.at < REPEAT_GUARD_MS;

  if (playedLongEnough && !countedRecently) {
    return {
      state: { current: null, lastCounted: { key: current.key, at: now } },
      countedArtist: current.artist,
    };
  }
  return { state: { current: null, lastCounted: lastCounted ?? null }, countedArtist: null };
}

/**
 * A track was reported playing. The same track reported again changes nothing; a different one
 * closes the previous track (which may count a play) and starts timing this one.
 *
 * @param {TrackState | undefined} state
 * @param {string} artist
 * @param {string | undefined} title
 * @param {number} now
 * @returns {{ state: TrackState, countedArtist: string | null }}
 */
export function trackStarted(state, artist, title, now) {
  const key = trackKey(artist, title);
  if (state?.current?.key === key) return { state, countedArtist: null };

  const closed = playbackStopped(state, now);
  return {
    state: { current: { key, artist: artist.trim(), startedAt: now }, lastCounted: closed.state.lastCounted },
    countedArtist: closed.countedArtist,
  };
}
