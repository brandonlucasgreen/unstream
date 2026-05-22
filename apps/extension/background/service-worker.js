// Unstream Chrome Extension - Service Worker
// Handles API calls, caching, badge updates, and release alerts

import { ALLOWED_RELEASE_DOMAINS } from '../lib/constants.js';

const API_BASE = 'https://unstream.stream/api';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
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
    handleMusicDetection(message.data);
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
    getResults(message.artist).then(sendResponse);
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
async function handleMusicDetection(data) {
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

  // Store current artist info
  await chrome.storage.local.set({
    currentTrack: { artist, title, source, timestamp: now }
  });

  // Track extension activation with streaming service
  trackAppEvent('extension_activated', { streaming_service: source || 'unknown' });

  // Fetch results
  try {
    const data = await searchArtist(artist);
    const results = data.results || [];

    // Store results
    await chrome.storage.local.set({
      [`cache:${artist}`]: { results, timestamp: now }
    });

    // Track search (product analytics)
    trackAppEvent('search', { has_results: results.length > 0, result_count: results.length });

    // Track search appearances for claimed artists
    for (const result of results) {
      if (result.type === 'artist' && result.claimedSlug) {
        trackAnalyticsEvent(result.claimedSlug, 'search');
      }
    }

    // Update badge based on results
    if (results.length > 0) {
      updateBadge('found', results.length);

      // Send artist detection notification if enabled
      await maybeNotifyArtist(artist, results);
    } else {
      updateBadge('none');
    }

    // Trigger enrichment in background
    enrichArtist(artist);
  } catch (error) {
    console.error('Search error:', error);
    updateBadge('error');
  }
}

// Handle when music stops playing
function handleMusicStopped() {
  currentArtist = null;
  updateBadge('idle');
}

// Search for artist via Unstream API
async function searchArtist(artist) {
  const url = `${API_BASE}/search/sources?query=${encodeURIComponent(artist)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Get results from cache or API
async function getResults(artist) {
  const cacheKey = `cache:${artist}`;
  const cached = await chrome.storage.local.get(cacheKey);

  if (cached[cacheKey]) {
    const { results, timestamp } = cached[cacheKey];
    if (Date.now() - timestamp < CACHE_TTL) {
      return { results, cached: true };
    }
  }

  // Fetch fresh
  try {
    const data = await searchArtist(artist);
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

  const foundNewReleases = [];

  for (const artistName of artistNames) {
    const artistData = savedArtistsData[artistName];
    if (!artistData || !artistData.platforms) continue;

    // Build platforms dict
    const platforms = {};
    for (const p of artistData.platforms) {
      if (['bandcamp', 'faircamp', 'mirlo', 'qobuz'].includes(p.sourceId)) {
        platforms[p.sourceId] = p.url;
      }
    }

    if (Object.keys(platforms).length === 0) continue;

    // Call release check API
    try {
      const result = await checkReleaseAPI(artistName, platforms);

      if (result && result.release) {
        const release = result.release;
        const key = artistName.toLowerCase();

        // Check if already known (by release name across all platforms)
        const knownReleases = releaseCheckState.knownReleases[key] || [];
        const alreadyKnown = knownReleases.some(
          kr => kr.releaseName.toLowerCase() === release.releaseName.toLowerCase()
        );

        if (!alreadyKnown) {
          // New release found!
          const newRelease = {
            id: crypto.randomUUID(),
            artistName: artistName,
            releaseName: release.releaseName,
            releaseDate: release.releaseDate,
            releaseUrl: release.releaseUrl,
            platform: release.platform,
            detectedAt: new Date().toISOString(),
          };

          foundNewReleases.push(newRelease);

          // Add to known releases
          if (!releaseCheckState.knownReleases[key]) {
            releaseCheckState.knownReleases[key] = [];
          }
          releaseCheckState.knownReleases[key].push({
            releaseName: release.releaseName,
            releaseDate: release.releaseDate,
            platform: release.platform,
          });
        }
      }
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
async function checkReleaseAPI(artistName, platforms) {
  const url = `${API_BASE}/check-releases`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artistName, platforms }),
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

// Send notification for new release
async function sendReleaseNotification(release) {
  try {
    await chrome.notifications.create(`release-${release.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `New Release from ${release.artistName}`,
      message: `"${release.releaseName}" is out now on ${release.platform.charAt(0).toUpperCase() + release.platform.slice(1)}!`,
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
