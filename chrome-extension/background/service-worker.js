// Unstream Chrome Extension - Service Worker
// Handles API calls, caching, and badge updates

const API_BASE = 'https://unstream.stream/api';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 2000; // 2 seconds debounce for same artist

// Current state
let currentArtist = null;
let lastSearchTime = 0;

// Listen for messages from content scripts
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
