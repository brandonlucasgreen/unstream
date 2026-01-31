// Unstream Chrome Extension - Service Worker
// Handles API calls, caching, badge updates, and release alerts

const API_BASE = 'https://unstream.stream/api';
const RELEASE_API_BASE = 'https://unstream.stream/.netlify/functions';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 2000; // 2 seconds debounce for same artist
const RELEASE_CHECK_ALARM = 'releaseCheck';
const RELEASE_CHECK_INTERVAL_MINUTES = 7 * 24 * 60; // 7 days in minutes

// Current state
let currentArtist = null;
let lastSearchTime = 0;

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MUSIC_DETECTED') {
    handleMusicDetection(message.data);
  } else if (message.type === 'GET_CURRENT_ARTIST') {
    sendResponse({ artist: currentArtist });
  } else if (message.type === 'GET_RESULTS') {
    getResults(message.artist).then(sendResponse);
    return true; // Keep channel open for async response
  } else if (message.type === 'GET_ENRICHMENT') {
    getEnrichment(message.artist).then(sendResponse);
    return true;
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

// Handle music detection from content scripts
async function handleMusicDetection(data) {
  const { artist, title, source } = data;

  if (!artist) return;

  // Debounce: don't re-search same artist within 2 seconds
  const now = Date.now();
  if (artist === currentArtist && now - lastSearchTime < DEBOUNCE_MS) {
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

  // Fetch results
  try {
    const data = await searchArtist(artist);
    const results = data.results || [];

    // Store results
    await chrome.storage.local.set({
      [`cache:${artist}`]: { results, timestamp: now }
    });

    // Update badge based on results
    if (results.length > 0) {
      updateBadge('found', results.length);
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

// Initialize
updateBadge('idle');
setupReleaseAlerts();

// =====================
// Release Alert System
// =====================

// Setup release alert scheduling
async function setupReleaseAlerts() {
  // Check if pro user
  const { license } = await chrome.storage.sync.get('license');
  if (!license || license.status !== 'active') {
    return;
  }

  // Get last check time
  const { releaseCheckState = {} } = await chrome.storage.local.get('releaseCheckState');
  const lastCheck = releaseCheckState.lastCheckDate;
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  // Prune expired releases (older than 7 days)
  if (releaseCheckState.newReleases && releaseCheckState.newReleases.length > 0) {
    releaseCheckState.newReleases = releaseCheckState.newReleases.filter(
      r => now - new Date(r.detectedAt).getTime() < sevenDays
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
  // Check license
  const { license } = await chrome.storage.sync.get('license');
  if (!license || license.status !== 'active') {
    return { checked: false, reason: 'no_license' };
  }

  // Get saved artists with their platform data
  const { savedArtistsData = {} } = await chrome.storage.sync.get('savedArtistsData');
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
  const url = `${RELEASE_API_BASE}/check-releases`;

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

  // Filter to only active releases (within 7 days of detection)
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const activeReleases = releases.filter(
    r => now - new Date(r.detectedAt).getTime() < sevenDays
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
  if (notificationId.startsWith('release-')) {
    const releaseId = notificationId.replace('release-', '');
    const releases = await getNewReleases();
    const release = releases.find(r => r.id === releaseId);

    if (release && release.releaseUrl) {
      chrome.tabs.create({ url: release.releaseUrl });
    }
  }
});
