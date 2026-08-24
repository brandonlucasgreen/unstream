// Unstream Chrome Extension - Service Worker
// Handles API calls, caching, badge updates, release alerts, and auth
//
// This file uses ES module imports, so **both** manifests must declare it as a module —
// `"type": "module"` alongside `service_worker` in manifest.json and alongside `scripts` in
// manifest-firefox.json. Firefox's manifest was missing it, which meant the first `import` was a
// syntax error and none of this ran there at all: no release alerts, no badge, no auth. It fails
// silently unless you open the extension's console, so check both files when adding an import.

import { ALLOWED_RELEASE_DOMAINS } from '../lib/constants.js';
import { getStoredSession, handleMagicLinkCallback, getAccessToken, signOut } from '../lib/supabase.js';
import { reconcileCustomSites } from '../lib/custom-sites.js';
import {
  releasesFromResponse,
  releaseNotificationBody,
  releaseNotificationTitle,
  selectUnseenReleases,
  sinceDaysForCheck,
} from '../lib/release-alerts.js';

const API_BASE = 'https://unstream.stream/api';
// 30 minutes, matching PLATFORM_CACHE_TTL in api/functions/search-sources.ts. Being fresher
// than the backend's own platform cache buys nothing, and at five minutes this cache expired
// faster than a song is long — so a listener changing tracks missed it every single time.
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const DEBOUNCE_MS = 2000; // 2 seconds debounce for same artist
const RELEASE_CHECK_ALARM = 'releaseCheck';

function isAllowedReleaseUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_RELEASE_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}
const RELEASE_CHECK_INTERVAL_MINUTES = 7 * 24 * 60; // 7 days in minutes

// Current state
let currentArtist = null;
let lastSearchTime = 0;

// Artist notification state (session-scoped — resets on browser restart)
// Cap at 200 to prevent unbounded growth
const MAX_NOTIFIED_ARTISTS = 200;
const notifiedArtists = new Set();

function addNotifiedArtist(slug) {
  if (notifiedArtists.size >= MAX_NOTIFIED_ARTISTS) {
    // Evict oldest entry
    const first = notifiedArtists.values().next().value;
    notifiedArtists.delete(first);
  }
  notifiedArtists.add(slug);
}

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MUSIC_DETECTED') {
    handleMusicDetection(message.data, sender.tab?.id);
  } else if (message.type === 'GET_CURRENT_ARTIST') {
    // If in-memory state was lost (service worker restart), restore from storage
    if (currentArtist === null) {
      chrome.storage.local.get('currentTrack').then(({ currentTrack }) => {
        if (currentTrack && Date.now() - currentTrack.timestamp < 5 * 60 * 1000) {
          currentArtist = currentTrack.artist;
          lastSearchTime = currentTrack.timestamp;
          sendResponse({ artist: currentArtist });
        } else {
          sendResponse({ artist: null });
        }
      });
      return true; // Keep channel open for async response
    }
    sendResponse({ artist: currentArtist });
  } else if (message.type === 'GET_RESULTS') {
    getResults(message.artist, message.mode).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.type === 'GET_ENRICHMENT') {
    getEnrichment(message.artist).then(sendResponse);
    return true;
  } else if (message.type === 'TRACK_ANALYTICS') {
    trackAnalyticsEvent(message.slug, message.metric);
  } else if (message.type === 'TRACK_APP_EVENT') {
    trackAppEvent(message.event_type, message.context || {});
  } else if (message.type === 'MUSIC_STOPPED') {
    handleMusicStopped();
  } else if (message.type === 'CHECK_RELEASES_NOW') {
    checkForNewReleases().then(sendResponse);
    return true;
  } else if (message.type === 'GET_NEW_RELEASES') {
    getNewReleases().then(sendResponse);
    return true;
  } else if (message.type === 'DISMISS_RELEASE') {
    dismissRelease(message.releaseId).then(sendResponse);
    return true;
  } else if (message.type === 'AUTH_GET_SESSION') {
    getStoredSession().then(session => sendResponse({ session })).catch(() => sendResponse({ session: null }));
    return true;
  } else if (message.type === 'AUTH_MAGIC_LINK_CALLBACK') {
    handleMagicLinkCallback(message.url).then(session => sendResponse({ session })).catch(() => sendResponse({ session: null }));
    return true;
  } else if (message.type === 'AUTH_SIGN_OUT') {
    signOut().then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: true }));
    return true;
  } else if (message.type === 'AUTH_GET_TOKEN') {
    getAccessToken().then(token => sendResponse({ token })).catch(() => sendResponse({ token: null }));
    return true;
  }
});

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RELEASE_CHECK_ALARM) {
    checkForNewReleases();
  }
});

// Fire-and-forget analytics event for artist-level tracking
async function trackAnalyticsEvent(slug, metric) {
  try {
    await fetch(`${API_BASE}/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, metric }),
    });
  } catch {
    // silent fail
  }
}

// Fire-and-forget product analytics event
async function trackAppEvent(event_type, context = {}) {
  try {
    await fetch(`${API_BASE}/analytics/app-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type, app: 'extension', context }),
    });
  } catch {
    // silent fail
  }
}

// Handle music detection from content scripts
async function handleMusicDetection(data, tabId) {
  const { artist, title, source } = data;

  if (!artist) return;

  // Debounce: don't re-search same artist within 2 seconds
  const now = Date.now();
  if (artist.toLowerCase() === currentArtist?.toLowerCase() && now - lastSearchTime < DEBOUNCE_MS) {
    return;
  }

  currentArtist = artist;
  lastSearchTime = now;

  // Update badge to show music detected
  updateBadge('detecting');

  // Store current artist info. tabId lets the popup verify a "fresh" track
  // actually came from the tab it's currently looking at, not some other tab.
  await chrome.storage.local.set({
    currentTrack: { artist, title, source, timestamp: now, tabId: tabId ?? null }
  });

  // Track extension activation with streaming service
  trackAppEvent('extension_activated', { streaming_service: source || 'unknown' });

  // Read through the cache rather than always fetching.
  //
  // This used to call searchArtist() directly, which meant it *wrote* `cache:${artist}` on
  // every track and never once read it — the cache was populated and then ignored. The
  // content script sends MUSIC_DETECTED on every title change, so playing one artist's album
  // fired an identical /api/search/sources for all twelve tracks, and the 2-second debounce
  // never caught them because tracks are minutes apart. Each of those requests costs real
  // Upstash commands on a metered free tier.
  const { results, error } = await getResults(artist);

  // getResults swallows the failure and reports it, so the error badge has to come from the
  // reported error — treating a failed fetch as "no results" would tell the listener this
  // artist isn't on any platform when we simply couldn't ask.
  if (error) {
    console.error('Search error:', error);
    updateBadge('error');
    return;
  }

  // Analytics fire on every detection, cache hit or not. A listener really did play this
  // artist, so the artist's search appearance is a real event wherever the results came
  // from — suppressing it on a cache hit would under-report to the artist.
  trackAppEvent('search', { has_results: results.length > 0, result_count: results.length });

  for (const result of results) {
    if (result.type === 'artist' && result.claimedSlug) {
      trackAnalyticsEvent(result.claimedSlug, 'search');
    }
  }

  if (results.length > 0) {
    updateBadge('found', results.length);

    // Send artist detection notification if enabled
    await maybeNotifyArtist(artist, results);
  } else {
    updateBadge('none');
  }

  // Trigger enrichment in background (cached separately, see enrichArtist)
  enrichArtist(artist);
}

// Handle when music stops playing
function handleMusicStopped() {
  currentArtist = null;
  updateBadge('idle');
}

// Search for artist via Unstream API.
// mode=exact is the extension's default: queries here come from track metadata,
// so a partial-name match would be a different artist than the one playing.
// Only the popup's manual search box passes 'fuzzy'.
async function searchArtist(artist, mode = 'exact') {
  const url = `${API_BASE}/search/sources?query=${encodeURIComponent(artist)}&mode=${mode}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Get results from cache or API. Exact and fuzzy results are cached separately —
// the fuzzy set for a name is a superset and must not answer a detection lookup.
async function getResults(artist, mode = 'exact') {
  const cacheKey = mode === 'fuzzy' ? `cache:fuzzy:${artist}` : `cache:${artist}`;
  const cached = await chrome.storage.local.get(cacheKey);

  if (cached[cacheKey]) {
    const { results, timestamp } = cached[cacheKey];
    if (Date.now() - timestamp < CACHE_TTL) {
      return { results, cached: true };
    }
  }

  // Fetch fresh
  try {
    const data = await searchArtist(artist, mode);
    const results = data.results || [];
    await chrome.storage.local.set({
      [cacheKey]: { results, timestamp: Date.now() }
    });
    return { results, cached: false };
  } catch (error) {
    return { results: [], error: error.message };
  }
}

// Enrich artist with MusicBrainz data (lazy)
async function enrichArtist(artist) {
  const enrichKey = `enrichment:${artist}`;
  const cached = await chrome.storage.local.get(enrichKey);

  // Check cache
  if (cached[enrichKey]) {
    const { timestamp } = cached[enrichKey];
    if (Date.now() - timestamp < CACHE_TTL) {
      return; // Already enriched recently
    }
  }

  try {
    const url = `${API_BASE}/search/musicbrainz?query=${encodeURIComponent(artist)}`;
    const response = await fetch(url);

    if (response.ok) {
      const data = await response.json();
      await chrome.storage.local.set({
        [enrichKey]: { data, timestamp: Date.now() }
      });
    }
  } catch (error) {
    console.error('Enrichment error:', error);
  }
}

// Get enrichment data for artist
async function getEnrichment(artist) {
  const enrichKey = `enrichment:${artist}`;
  const cached = await chrome.storage.local.get(enrichKey);

  if (cached[enrichKey]) {
    const { data, timestamp } = cached[enrichKey];
    if (Date.now() - timestamp < CACHE_TTL) {
      return data;
    }
  }

  // Fetch enrichment and wait for it to complete
  try {
    const url = `${API_BASE}/search/musicbrainz?query=${encodeURIComponent(artist)}`;
    const response = await fetch(url);

    if (response.ok) {
      const data = await response.json();
      await chrome.storage.local.set({
        [enrichKey]: { data, timestamp: Date.now() }
      });
      return data;
    }
  } catch (error) {
    console.error('Enrichment error:', error);
  }

  return null;
}

// Update extension badge
function updateBadge(state, count = 0) {
  switch (state) {
    case 'detecting':
      chrome.action.setBadgeBackgroundColor({ color: '#FFA500' }); // Orange
      chrome.action.setBadgeText({ text: '...' });
      break;
    case 'found':
      chrome.action.setBadgeBackgroundColor({ color: '#22C55E' }); // Green
      chrome.action.setBadgeText({ text: count.toString() });
      break;
    case 'none':
      chrome.action.setBadgeBackgroundColor({ color: '#6B7280' }); // Gray
      chrome.action.setBadgeText({ text: '0' });
      break;
    case 'error':
      chrome.action.setBadgeBackgroundColor({ color: '#EF4444' }); // Red
      chrome.action.setBadgeText({ text: '!' });
      break;
    case 'idle':
    default:
      chrome.action.setBadgeText({ text: '' });
      break;
  }
}

// Prune stale cache and enrichment entries older than 24 hours
async function pruneStaleCache() {
  const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
  try {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = [];
    const now = Date.now();

    for (const [key, value] of Object.entries(all)) {
      if ((key.startsWith('cache:') || key.startsWith('enrichment:')) && value && value.timestamp) {
        if (now - value.timestamp > MAX_AGE) {
          keysToRemove.push(key);
        }
      }
    }

    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch {
    // Non-critical — ignore errors
  }
}

// Initialize: restore state from storage in case service worker was restarted
async function restoreState() {
  try {
    const { currentTrack } = await chrome.storage.local.get('currentTrack');
    if (currentTrack && Date.now() - currentTrack.timestamp < 5 * 60 * 1000) {
      currentArtist = currentTrack.artist;
      lastSearchTime = currentTrack.timestamp;
      updateBadge('found');
    } else {
      updateBadge('idle');
    }
  } catch {
    updateBadge('idle');
  }
}

restoreState();
pruneStaleCache();
setupReleaseAlerts();

// Keep user-enabled custom sites (UNS-152) in sync across restarts: re-register
// any missing content scripts and prune origins whose permission was revoked
// out-of-band via browser settings.
chrome.runtime.onInstalled.addListener(() => { reconcileCustomSites(); });
chrome.runtime.onStartup.addListener(() => { reconcileCustomSites(); });
// Also reconcile immediately when a permission is revoked (e.g. via the
// browser's site/extension settings) instead of waiting for the next
// install/startup, so a stale registration doesn't linger for the rest of
// the browsing session.
chrome.permissions.onRemoved.addListener(() => { reconcileCustomSites(); });
reconcileCustomSites();

// ========================================
// Artist Detection Notification System
// ========================================

/**
 * Check if artist notifications are enabled (default: true).
 * Existing users are opted in on upgrade.
 */
async function artistNotificationsEnabled() {
  const { artistNotifications } = await chrome.storage.sync.get('artistNotifications');
  // Default to enabled (true) — undefined means not set yet, treat as enabled
  return artistNotifications !== false;
}

/**
 * Format notification copy for an artist detection.
 * Shows artist name, total platform count, and up to 2 named platforms.
 * Skips notification if no support platforms found.
 */
function formatArtistNotification(artistName, results) {
  // Find the artist result (type === 'artist')
  const artistResult = results.find(r => r.type === 'artist');

  // Get platform count and names
  // Use the first (best) result's platforms if it's an artist, otherwise the first result
  const primaryResult = artistResult || results[0];
  if (!primaryResult || !primaryResult.platforms || primaryResult.platforms.length === 0) {
    return null; // No platforms — don't notify
  }

  const platformCount = primaryResult.platforms.length;
  const platformNames = primaryResult.platforms
    .slice(0, 2)
    .map(p => p.name || p.sourceId);

  let message;
  if (platformCount === 1) {
    message = `Support directly on ${platformNames[0]}.`;
  } else if (platformCount === 2) {
    message = `Support directly on ${platformNames[0]} and ${platformNames[1]}.`;
  } else {
    message = `Support directly on ${platformCount} platforms including ${platformNames[0]} and ${platformNames[1]}.`;
  }

  // Use claimedSlug if available (stable, URL-safe), otherwise slugify artist name.
  // Always use claimedSlug as the canonical key to avoid duplicate notifications
  // when the same artist appears with and without a claimed profile.
  const slug = primaryResult.claimedSlug || artistName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return {
    title: `Now playing: ${artistName}`,
    message,
    slug,
  };
}

/**
 * Maybe send an artist detection notification.
 * Respects: enabled setting, session-based duplicate suppression, platform availability.
 */
async function maybeNotifyArtist(artistName, results) {
  // Check if notifications are enabled
  if (!await artistNotificationsEnabled()) return;

  // Format notification content (also computes the URL-safe slug)
  const notification = formatArtistNotification(artistName, results);
  if (!notification) return; // No platforms found — skip

  // Check session-based duplicate suppression using slug
  if (notifiedArtists.has(notification.slug)) return;

  // Mark as notified for this session
  addNotifiedArtist(notification.slug);

  // Send browser notification
  try {
    await chrome.notifications.create(`artist-${notification.slug}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: notification.title,
      message: notification.message,
      priority: 2,
    });
  } catch (error) {
    console.error('Failed to send artist notification:', error);
  }
}

// =====================
// Release Alert System
// ======================

// Setup release alert scheduling
async function setupReleaseAlerts() {
  // Get last check time
  const { releaseCheckState = {} } = await chrome.storage.local.get('releaseCheckState');
  const lastCheck = releaseCheckState.lastCheckDate;
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  // Prune expired releases (older than 30 days)
  if (releaseCheckState.newReleases && releaseCheckState.newReleases.length > 0) {
    releaseCheckState.newReleases = releaseCheckState.newReleases.filter(
      r => now - new Date(r.detectedAt).getTime() < thirtyDays
    );
    await chrome.storage.local.set({ releaseCheckState });
  }

  if (!lastCheck) {
    // First run - initialize state, schedule for later
    releaseCheckState.lastCheckDate = now;
    releaseCheckState.knownReleases = releaseCheckState.knownReleases || {};
    releaseCheckState.newReleases = releaseCheckState.newReleases || [];
    await chrome.storage.local.set({ releaseCheckState });
    scheduleNextReleaseCheck();
  } else if (now - lastCheck > sevenDays) {
    // More than 7 days since last check - check now
    checkForNewReleases();
  } else {
    // Schedule for next check
    scheduleNextReleaseCheck();
  }
}

// Schedule next Friday 9am check
async function scheduleNextReleaseCheck() {
  // Clear existing alarm
  await chrome.alarms.clear(RELEASE_CHECK_ALARM);

  // Calculate next Friday 9am
  const now = new Date();
  const daysUntilFriday = (5 - now.getDay() + 7) % 7 || 7;
  const nextFriday = new Date(now);
  nextFriday.setDate(now.getDate() + daysUntilFriday);
  nextFriday.setHours(9, 0, 0, 0);

  // If next Friday already passed today, add a week
  if (nextFriday <= now) {
    nextFriday.setDate(nextFriday.getDate() + 7);
  }

  const delayMinutes = (nextFriday.getTime() - now.getTime()) / (60 * 1000);

  // Create alarm
  await chrome.alarms.create(RELEASE_CHECK_ALARM, {
    delayInMinutes: delayMinutes,
    periodInMinutes: RELEASE_CHECK_INTERVAL_MINUTES,
  });
}

// Check for new releases
async function checkForNewReleases() {
  // Get saved artists with their platform data
  const { savedArtistsData = {} } = await chrome.storage.local.get('savedArtistsData');
  const artistNames = Object.keys(savedArtistsData);

  if (artistNames.length === 0) {
    return { checked: true, newCount: 0 };
  }

  // Get current state
  const { releaseCheckState = { knownReleases: {}, newReleases: [] } } = await chrome.storage.local.get('releaseCheckState');
  if (!releaseCheckState.knownReleases) releaseCheckState.knownReleases = {};

  // How far back to ask. Left unsent, the server looks back 31 days, so a browser that was closed
  // for six weeks came back, found nothing older than that, and recorded a fresh check date —
  // losing the gap permanently.
  const sinceDays = sinceDaysForCheck(releaseCheckState.lastCheckDate);

  const foundNewReleases = [];

  for (const artistName of artistNames) {
    const artistData = savedArtistsData[artistName];
    if (!artistData) continue;

    // Every link we hold for this artist, keyed by source.
    //
    // No filtering, and no skipping an artist who has none: the endpoint reads the catalogue
    // first and ignores these entirely on that path — only its live-scrape fallback uses them,
    // and only the sources it can scrape. Skipping anyone without a Bandcamp, Faircamp or Mirlo
    // link meant never asking about the largest link population we have (there are more Discogs
    // artist links in production than Bandcamp ones) over a question one database read answers.
    const platforms = {};
    for (const p of artistData.platforms || []) {
      if (p && p.sourceId && p.url) platforms[p.sourceId] = p.url;
    }

    // Call release check API
    try {
      const result = await checkReleaseAPI(artistName, platforms, sinceDays);

      // Every release in the window, not just the newest — an artist who put out two records
      // since the last check produces two alerts. selectUnseenReleases marks each one known as
      // it accepts it, and is the only dedup point.
      foundNewReleases.push(
        ...selectUnseenReleases(releasesFromResponse(result), artistName, releaseCheckState.knownReleases)
      );
    } catch (error) {
      console.error(`Release check failed for ${artistName}:`, error);
    }
  }

  // Update state with new releases
  if (foundNewReleases.length > 0) {
    releaseCheckState.newReleases = [
      ...foundNewReleases,
      ...(releaseCheckState.newReleases || []),
    ];

    // Send notifications
    for (const release of foundNewReleases) {
      sendReleaseNotification(release);
    }
  }

  // Update last check date
  releaseCheckState.lastCheckDate = Date.now();
  await chrome.storage.local.set({ releaseCheckState });

  // Schedule next check
  scheduleNextReleaseCheck();

  return { checked: true, newCount: foundNewReleases.length };
}

// Call the release check API
async function checkReleaseAPI(artistName, platforms, sinceDays) {
  const url = `${API_BASE}/check-releases`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artistName, platforms, sinceDays }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Get new releases from storage
async function getNewReleases() {
  const { releaseCheckState = {} } = await chrome.storage.local.get('releaseCheckState');
  const releases = releaseCheckState.newReleases || [];

  // Filter to only active releases (within 30 days of detection)
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const activeReleases = releases.filter(
    r => now - new Date(r.detectedAt).getTime() < thirtyDays
  );

  return activeReleases;
}

// Dismiss a release
async function dismissRelease(releaseId) {
  const { releaseCheckState = {} } = await chrome.storage.local.get('releaseCheckState');

  if (releaseCheckState.newReleases) {
    releaseCheckState.newReleases = releaseCheckState.newReleases.filter(
      r => r.id !== releaseId
    );
    await chrome.storage.local.set({ releaseCheckState });
  }

  return { success: true };
}

// Send notification for new release.
// Title and body come from release-alerts.js so this says the same thing the Mac app does — and,
// for an announced release, stops claiming a record dated next month is already out.
async function sendReleaseNotification(release) {
  try {
    await chrome.notifications.create(`release-${release.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: releaseNotificationTitle(release),
      message: releaseNotificationBody(release),
      priority: 2,
    });
  } catch (error) {
    console.error('Failed to send notification:', error);
  }
}

// Handle notification clicks
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith('artist-')) {
    const slugOrName = notificationId.replace('artist-', '');
    const url = `https://unstream.stream/a/${encodeURIComponent(slugOrName)}`;
    await chrome.tabs.create({ url });
  } else if (notificationId.startsWith('release-')) {
    const releaseId = notificationId.replace('release-', '');
    const releases = await getNewReleases();
    const release = releases.find(r => r.id === releaseId);

    if (release && release.releaseUrl && isAllowedReleaseUrl(release.releaseUrl)) {
      chrome.tabs.create({ url: release.releaseUrl });
    }
  }
});
