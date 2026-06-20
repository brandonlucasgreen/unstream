// Unstream Chrome Extension - Popup Logic

import { isBandcampFriday } from '../lib/bandcamp-friday.js';
import { ALLOWED_RELEASE_DOMAINS, SOURCE_CONFIG, PAYOUT_PERCENTAGES } from '../lib/constants.js';
import { signInWithPassword, signInWithOtp, signOut, getStoredSession, getAccessToken, getDeviceId } from '../lib/supabase.js';

const API_BASE = 'https://unstream.stream/api';

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

// Social icons - using inline SVG with explicit fill colors
const SOCIAL_ICONS = {
  instagram: '<svg viewBox="0 0 24 24"><path fill="#E4405F" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>',
  facebook: '<svg viewBox="0 0 24 24"><path fill="#1877F2" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24"><path fill="#E5E7EB" d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24"><path fill="#FF0000" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
  threads: '<svg viewBox="0 0 24 24"><path fill="#E5E7EB" d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>',
  bluesky: '<svg viewBox="0 0 24 24"><path fill="#0085FF" d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8z"/></svg>',
  mastodon: '<svg viewBox="0 0 24 24"><path fill="#6364FF" d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>',
  peertube: '<svg viewBox="0 0 24 24"><path fill="#F1680D" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-1.243 17.07V6.93L18.258 12l-7.5 5.07z"/></svg>',
};

// DOM Elements
const elements = {
  // Tab navigation
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  // Discover tab
  nowPlaying: document.getElementById('now-playing'),
  idleState: document.getElementById('idle-state'),
  resultsSection: document.getElementById('results-section'),
  resultsGrid: document.getElementById('results-grid'),
  socialSection: document.getElementById('social-section'),
  socialLinks: document.getElementById('social-links'),
  actionsSection: document.getElementById('actions-section'),
  saveArtistBtn: document.getElementById('save-artist-btn'),
  openBrowserBtn: document.getElementById('open-browser-btn'),
  reportIssueLink: document.getElementById('report-issue-link'),
  searchInput: document.getElementById('search-input'),
  searchBtn: document.getElementById('search-btn'),
  artistName: document.getElementById('artist-name'),
  artistLocation: document.getElementById('artist-location'),
  trackTitle: document.getElementById('track-title'),
  sourceBadge: document.getElementById('source-badge'),
  // Auth
  authSection: document.getElementById('auth-section'),
  authForm: document.getElementById('auth-form'),
  authEmail: document.getElementById('auth-email'),
  authPassword: document.getElementById('auth-password'),
  authSubmit: document.getElementById('auth-submit'),
  authError: document.getElementById('auth-error'),
  authMagicLink: document.getElementById('auth-magic-link'),
  magicLinkSent: document.getElementById('magic-link-sent'),
  authLoggedIn: document.getElementById('auth-logged-in'),
  authEmailDisplay: document.getElementById('auth-email-display'),
  authSignOut: document.getElementById('auth-sign-out'),
  syncNowBtn: document.getElementById('sync-now-btn'),
  // Saved tab
  releasesSection: document.getElementById('releases-section'),
  newReleases: document.getElementById('new-releases'),
  savedSection: document.getElementById('saved-section'),
  savedArtistsList: document.getElementById('saved-artists-list'),
  noSavedArtists: document.getElementById('no-saved-artists'),
  // Settings tab
  releaseAlertsSection: document.getElementById('release-alerts-section'),
  checkNowBtn: document.getElementById('check-now-btn'),
  lastCheckTime: document.getElementById('last-check-time'),
};

// State
let currentArtist = null;
let currentArtistSlug = null; // resolved slug for current artist
let currentResults = null;
let currentSocialLinks = null;
let currentLocation = null;
let newReleases = [];
let authSession = null; // null = unknown/loading, false = signed out, object = signed in

// Slug lookup cache: { artistName → slug }
const SLUG_CACHE_KEY = 'artistSlugCache';

// Look up the canonical slug for an artist name via the search API.
// This mirrors what the web app does (claimedSlug || result.id).
// Results are cached in chrome.storage.local so we don't re-fetch on every save.
async function lookupSlug(artistName) {
  if (!artistName) return null;

  // Check cache
  const { [SLUG_CACHE_KEY]: slugCache = {} } = await chrome.storage.local.get(SLUG_CACHE_KEY);
  const normalizedName = artistName.toLowerCase().trim();

  if (slugCache[normalizedName]) {
    return slugCache[normalizedName];
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_RESULTS',
      artist: artistName,
    });

    if (!response || response.error) return null;

    const results = response.results || [];
    // Find the best-matching artist result
    const match = results.find(r =>
      r.type === 'artist' && r.name && r.name.toLowerCase() === normalizedName
    ) || results.find(r =>
      r.type === 'artist' && r.name && r.name.toLowerCase().includes(normalizedName)
    );

    if (match) {
      const slug = match.claimedSlug || match.id;
      if (slug) {
        // Persist to cache
        slugCache[normalizedName] = slug;
        await chrome.storage.local.set({ [SLUG_CACHE_KEY]: slugCache });
        return slug;
      }
    }
  } catch {
    // Network error — fall back to slugifying locally
  }

  // Fallback: slugify the display name the same way the server does
  const fallbackSlug = artistName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (fallbackSlug) {
    slugCache[normalizedName] = fallbackSlug;
    await chrome.storage.local.set({ [SLUG_CACHE_KEY]: slugCache });
  }
  return fallbackSlug || null;
}

// ---- Auth ----

async function initAuth() {
  try {
    const { session } = await chrome.runtime.sendMessage({ type: 'AUTH_GET_SESSION' });
    if (session && session.user) {
      authSession = session;
      showLoggedInState(session.user);
    } else {
      authSession = false;
      showLoggedOutState();
    }
  } catch {
    // Service worker may be starting up — try reading from storage directly
    try {
      const session = await getStoredSession();
      if (session && session.user) {
        authSession = session;
        showLoggedInState(session.user);
      } else {
        authSession = false;
        showLoggedOutState();
      }
    } catch {
      authSession = false;
      showLoggedOutState();
    }
  }
}

function showLoggedInState(user) {
  elements.authSection.classList.add('hidden');
  elements.authLoggedIn.classList.remove('hidden');
  elements.authEmailDisplay.textContent = user.email || 'Signed in';
  elements.syncNowBtn.disabled = false;
  elements.syncNowBtn.textContent = '';
  // Rebuild the sync button content
  elements.syncNowBtn.innerHTML = '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '23 4 23 10 17 10');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
  svg.appendChild(polyline);
  svg.appendChild(path);
  elements.syncNowBtn.appendChild(svg);
  elements.syncNowBtn.appendChild(document.createTextNode(' Sync now'));
  // Update save button to show sync state
  updateSaveButton();
}

function showLoggedOutState() {
  elements.authSection.classList.remove('hidden');
  elements.authLoggedIn.classList.add('hidden');
  elements.authForm.reset();
  elements.authError.classList.add('hidden');
  elements.magicLinkSent.classList.add('hidden');
  elements.authSubmit.disabled = false;
  elements.authMagicLink.disabled = false;
}

async function handleSignIn(e) {
  e.preventDefault();
  const email = elements.authEmail.value.trim();
  const password = elements.authPassword.value;

  if (!email) return;

  elements.authSubmit.disabled = true;
  elements.authError.classList.add('hidden');

  if (password) {
    // Password sign-in
    const result = await signInWithPassword(email, password);
    if (result.error) {
      elements.authError.textContent = result.error;
      elements.authError.classList.remove('hidden');
      elements.authSubmit.disabled = false;
      return;
    }
    authSession = result.session;
    showLoggedInState(result.session.user);
    // Trigger initial sync
    syncSavedArtists();
  } else {
    // Magic link — redirect to OAuth flow
    elements.authSubmit.disabled = false;
    await handleMagicLink(email);
  }
}

async function handleMagicLink(email) {
  if (!email) return;

  elements.authMagicLink.disabled = true;
  elements.authError.classList.add('hidden');

  // Send the magic link email — the user will click the link in their email
  // which opens unstream.stream and establishes a session there.
  // The extension picks up the session on next popup open.
  const result = await signInWithOtp(email);

  if (result.error) {
    elements.authError.textContent = result.error;
    elements.authError.classList.remove('hidden');
    elements.authMagicLink.disabled = false;
    return;
  }

  // Show "check your email" message
  elements.magicLinkSent.classList.remove('hidden');
  elements.authForm.classList.add('hidden');
  elements.authMagicLink.classList.add('hidden');

  elements.authMagicLink.disabled = false;
}

async function handleSignOut() {
  await signOut();
  authSession = false;
  showLoggedOutState();
  // Clear synced artists — keep only local-only saves
  await clearSyncedArtists();
  loadSavedArtists();
}

async function clearSyncedArtists() {
  // Remove artists that came from server sync, keeping locally-saved ones
  const { syncedArtistSlugs = [] } = await chrome.storage.local.get('syncedArtistSlugs');
  if (syncedArtistSlugs.length === 0) return;

  const { savedArtists = [], savedArtistsData = {} } = await chrome.storage.local.get(['savedArtists', 'savedArtistsData']);
  const remaining = savedArtists.filter(name => !syncedArtistSlugs.includes(name));
  const remainingData = {};
  for (const name of remaining) {
    if (savedArtistsData[name]) remainingData[name] = savedArtistsData[name];
  }

  await chrome.storage.local.set({ savedArtists: remaining, savedArtistsData: remainingData });
  await chrome.storage.local.remove('syncedArtistSlugs');
  await chrome.storage.local.remove('lastSyncTime');
}

// ---- Saved Artists Sync ----

async function syncSavedArtists() {
  if (!authSession) return;

  elements.syncNowBtn.disabled = true;
  elements.syncNowBtn.classList.add('syncing');
  elements.syncNowBtn.textContent = 'Syncing...';

  try {
    const token = authSession.access_token || await getAccessToken();
    if (!token) return;

    const { lastSyncTime } = await chrome.storage.local.get('lastSyncTime');
    const since = lastSyncTime || '1970-01-01T00:00:00Z';

    const response = await fetch(`${API_BASE}/saved-artists/sync?since=${encodeURIComponent(since)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      console.error('Sync failed:', response.status);
      return;
    }

    const data = await response.json();
    const serverArtists = data.artists || [];

    if (serverArtists.length === 0 && !lastSyncTime) {
      // First sync, no server artists — just save the sync timestamp
      await chrome.storage.local.set({ lastSyncTime: data.server_time });
      // Reset the sync button but don't reload the list (nothing changed)
      return;
    }

    // Merge server artists into local state
    const { savedArtists = [], savedArtistsData = {}, syncedArtistSlugs: prevSynced = [] } = await chrome.storage.local.get(['savedArtists', 'savedArtistsData', 'syncedArtistSlugs']);
    const syncedSlugs = [];

    for (const artist of serverArtists) {
      const slug = artist.slug || artist.artistId;
      if (!slug) continue;

      syncedSlugs.push(slug);

      // Add to local list if not present
      if (!savedArtists.includes(slug)) {
        savedArtists.push(slug);
      }

      // Build artist data from server record
      savedArtistsData[slug] = {
        platforms: (artist.claimed && artist.slug) ? [{ sourceId: 'unstream', url: `https://unstream.stream/a/${artist.slug}` }] : [],
        socialLinks: [],
        location: null,
        imageUrl: artist.imageUrl || null,
        name: artist.name || slug,
        slug: artist.slug || '',
        claimed: artist.claimed || false,
        supported: artist.supported || false,
        lastModified: artist.lastModified || null,
      };
    }

    // Union with previously synced slugs so incremental syncs don't lose history
    const mergedSlugs = new Set([...prevSynced, ...syncedSlugs]);

    await chrome.storage.local.set({
      savedArtists,
      savedArtistsData,
      syncedArtistSlugs: [...mergedSlugs],
      lastSyncTime: data.server_time,
    });

    // Reload the saved artists display
    loadSavedArtists();
  } catch (error) {
    console.error('Sync error:', error);
  } finally {
    elements.syncNowBtn.disabled = false;
    elements.syncNowBtn.classList.remove('syncing');
    // Reset button content
    elements.syncNowBtn.innerHTML = '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '23 4 23 10 17 10');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10');
    svg.appendChild(polyline);
    svg.appendChild(path);
    elements.syncNowBtn.appendChild(svg);
    elements.syncNowBtn.appendChild(document.createTextNode(' Sync now'));
  }
}

// Save an artist to the server (when logged in)
// artistSlug should be the canonical slug (from lookupSlug), not a display name
async function saveArtistToServer(artistSlug, artistData) {
  if (!authSession) return; // TODO: queue saves fired before initAuth completes

  const token = authSession.access_token || await getAccessToken();
  if (!token) return;

  const deviceId = await getDeviceId();

  try {
    await fetch(`${API_BASE}/saved-artists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        artistId: artistSlug,
        name: artistData.name || artistSlug,
        imageUrl: artistData.imageUrl || null,
        last_modified: new Date().toISOString(),
        device_id: deviceId,
      }),
    });
  } catch {
    // Silent — local save is still preserved
  }
}

// Remove an artist from the server (when logged in)
// artistSlug should be the canonical slug
async function removeArtistFromServer(artistSlug) {
  if (!authSession) return;

  const token = authSession.access_token || await getAccessToken();
  if (!token) return;

  try {
    await fetch(`${API_BASE}/saved-artists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        action: 'remove',
        artistId: artistSlug,
      }),
    });
  } catch {
    // Silent — local removal is still preserved
  }
}

// Format ArtistLocation object to "City, Country" string
function formatLocation(location) {
  if (!location) return '';
  const region = location.country || location.countryCode;
  if (location.city && region) return `${location.city}, ${region}`;
  if (location.city) return location.city;
  if (region) return region;
  return '';
}

// Initialize popup
async function init() {
  // Initialize auth state
  await initAuth();

  // Get current track from storage
  const { currentTrack } = await chrome.storage.local.get('currentTrack');

  if (currentTrack && Date.now() - currentTrack.timestamp < 5 * 60 * 1000) {
    showNowPlaying(currentTrack);
    await loadResults(currentTrack.artist);
    await loadEnrichment(currentTrack.artist);
  }

  // Load saved artists and releases
  await loadSavedArtists();
  await loadNewReleases();
  await loadLastCheckTime();

  // Initialize artist notification toggle state
  const { artistNotifications } = await chrome.storage.sync.get('artistNotifications');
  document.getElementById('artist-notifications-toggle').checked = artistNotifications !== false; // default enabled

  // Setup event listeners
  setupEventListeners();
}

// Show now playing
function showNowPlaying(track) {
  currentArtist = track.artist;
  currentArtistSlug = null; // will be resolved asynchronously
  currentLocation = null;
  elements.artistName.textContent = track.artist;
  elements.artistLocation.textContent = '';
  elements.trackTitle.textContent = track.title || '';
  elements.sourceBadge.textContent = track.source;

  elements.nowPlaying.classList.remove('hidden');
  elements.idleState.classList.add('hidden');
  elements.actionsSection.classList.remove('hidden');

  updateSaveButton();

  // Resolve the canonical slug for this artist
  lookupSlug(track.artist).then(slug => {
    currentArtistSlug = slug;
    updateSaveButton();
  });
}

// Hide now playing
function hideNowPlaying() {
  currentArtist = null;
  currentArtistSlug = null;
  currentResults = null;
  currentLocation = null;
  elements.artistLocation.textContent = '';
  elements.nowPlaying.classList.add('hidden');
  elements.idleState.classList.remove('hidden');
  elements.resultsSection.classList.add('hidden');
  elements.socialSection.classList.add('hidden');
  elements.actionsSection.classList.add('hidden');
}

// Load results for artist
async function loadResults(artist) {
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'loading';
  loadingDiv.textContent = 'Loading...';
  elements.resultsGrid.replaceChildren(loadingDiv);
  elements.resultsSection.classList.remove('hidden');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_RESULTS',
      artist,
    });

    if (!response || response.error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'error';
      errorDiv.textContent = 'Failed to load results';
      elements.resultsGrid.replaceChildren(errorDiv);
      return;
    }

    currentResults = response.results || [];
    renderResults(currentResults);
  } catch (error) {
    console.error('loadResults error:', error);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.textContent = 'Extension is reloading, please try again';
    elements.resultsGrid.replaceChildren(errorDiv);
  }
}

// Render results
function renderResults(results) {
  // Extract claimedSlug for analytics tracking
  const claimedResult = results.find(r => r.type === 'artist' && r.claimedSlug);
  const claimedSlug = claimedResult?.claimedSlug || null;

  // Extract location: prefer claimed result, otherwise first artist-type result with location
  const locationResult = (claimedResult?.location ? claimedResult : null)
    || results.find(r => r.type === 'artist' && r.location);
  currentLocation = locationResult?.location || null;
  elements.artistLocation.textContent = formatLocation(currentLocation);

  const allPlatforms = [];
  for (const result of results) {
    if (result.platforms && Array.isArray(result.platforms)) {
      for (const platform of result.platforms) {
        allPlatforms.push({ sourceId: platform.sourceId, url: platform.url });
      }
    }
  }

  const seen = new Set();
  const nonSocialPlatforms = allPlatforms.filter(p => {
    if (isSocialSource(p.sourceId)) return false;
    if (isSearchOnlySource(p.sourceId, p.url)) return false;
    if (seen.has(p.sourceId)) return false;
    seen.add(p.sourceId);
    return true;
  });

  if (nonSocialPlatforms.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty';
    emptyDiv.textContent = 'No alternative sources found';
    elements.resultsGrid.replaceChildren(emptyDiv);
    return;
  }

  const bcFriday = isBandcampFriday();
  const fragment = document.createDocumentFragment();
  nonSocialPlatforms.slice(0, 8).forEach(platform => {
    const config = SOURCE_CONFIG[platform.sourceId] || { icon: '🔗', name: platform.sourceId };
    const link = document.createElement('a');
    link.href = platform.url;
    link.target = '_blank';
    link.className = 'result-item';
    link.title = config.name;
    link.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'TRACK_APP_EVENT', event_type: 'platform_click', context: { platform: platform.sourceId } });
      if (claimedSlug) {
        chrome.runtime.sendMessage({ type: 'TRACK_ANALYTICS', slug: claimedSlug, metric: `click:${platform.sourceId}` });
      }
    });

    const iconSpan = document.createElement('span');
    iconSpan.className = 'result-icon';
    iconSpan.textContent = config.icon;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'result-name';

    // Bandcamp Friday indicator
    if (platform.sourceId === 'bandcamp' && bcFriday) {
      nameSpan.textContent = config.name;
      const bcBadge = document.createElement('span');
      bcBadge.className = 'bc-friday-badge';
      bcBadge.textContent = 'BC Friday!';
      bcBadge.title = "It's Bandcamp Friday! Bandcamp waives their revenue share today, so artists get ~97% of every sale.";
      nameSpan.appendChild(bcBadge);
    } else {
      nameSpan.textContent = config.name;
    }

    // Payout percentage badge
    const payoutPercent = PAYOUT_PERCENTAGES[platform.sourceId];
    if (payoutPercent) {
      const displayPayout = (platform.sourceId === 'bandcamp' && bcFriday) ? '~97%' : payoutPercent;
      const payoutBadge = document.createElement('span');
      payoutBadge.className = 'payout-badge';
      payoutBadge.textContent = displayPayout;
      payoutBadge.title = (platform.sourceId === 'bandcamp' && bcFriday)
        ? "It's Bandcamp Friday! Artists get ~97% of every sale."
        : 'Approximate percentage of a sale the artist receives on this platform.';
      nameSpan.appendChild(payoutBadge);
    }

    link.appendChild(iconSpan);
    link.appendChild(nameSpan);
    fragment.appendChild(link);
  });
  elements.resultsGrid.replaceChildren(fragment);
}

// Check if source is social
function isSocialSource(id) {
  return ['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'peertube'].includes(id);
}

// Check if URL is a search URL
function isSearchUrl(url) {
  if (!url) return true;
  const lowercased = url.toLowerCase();
  const searchPatterns = ['/search', '?q=', '?query=', '/explore', 'duckduckgo.com'];
  return searchPatterns.some(pattern => lowercased.includes(pattern));
}

// Check if source is search-only
function isSearchOnlySource(id, url) {
  const searchOnlyIds = ['ampwall', 'nina', 'kofi', 'buymeacoffee'];
  if (!searchOnlyIds.includes(id)) return false;
  return isSearchUrl(url);
}

// Load enrichment (MusicBrainz data)
async function loadEnrichment(artist) {
  try {
    const enrichment = await chrome.runtime.sendMessage({
      type: 'GET_ENRICHMENT',
      artist,
    });

    if (enrichment && enrichment.socialLinks && enrichment.socialLinks.length > 0) {
      currentSocialLinks = enrichment.socialLinks;
      renderSocialLinks(enrichment.socialLinks);
    } else {
      currentSocialLinks = null;
    }
  } catch (error) {
    console.error('loadEnrichment error:', error);
    currentSocialLinks = null;
  }
}

// Render social links with colored SVG icons
function renderSocialLinks(links) {
  if (links.length === 0) return;

  const fragment = document.createDocumentFragment();

  links.forEach(link => {
    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.target = '_blank';
    anchor.className = 'social-link';
    anchor.title = link.platform;

    const iconSvg = SOCIAL_ICONS[link.platform];
    if (iconSvg) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(iconSvg, 'image/svg+xml');
      anchor.appendChild(doc.documentElement);
    }
    fragment.appendChild(anchor);
  });

  elements.socialLinks.replaceChildren(fragment);
  elements.socialSection.classList.remove('hidden');
}

// Update save button state
async function updateSaveButton() {
  if (!currentArtist) return;

  const { savedArtists = [] } = await chrome.storage.local.get('savedArtists');
  // Check by slug if resolved, otherwise fall back to display name
  const key = currentArtistSlug || currentArtist;
  const isSaved = savedArtists.includes(key) || savedArtists.includes(currentArtist);

  const starSpan = document.createElement('span');
  starSpan.className = 'star';

  if (isSaved) {
    starSpan.textContent = '\u2605';
    elements.saveArtistBtn.replaceChildren(starSpan, document.createTextNode(' Saved'));
    elements.saveArtistBtn.classList.add('saved');
  } else {
    starSpan.textContent = '\u2606';
    elements.saveArtistBtn.replaceChildren(starSpan, document.createTextNode(' Save Artist'));
    elements.saveArtistBtn.classList.remove('saved');
  }
}

// Save/unsave artist
async function toggleSaveArtist() {
  if (!currentArtist) return;

  // Resolve slug if not yet available
  const slug = currentArtistSlug || await lookupSlug(currentArtist);
  if (slug) currentArtistSlug = slug;

  const key = slug || currentArtist; // use slug as canonical key, display name as fallback
  const { savedArtists = [], savedArtistsData = {} } = await chrome.storage.local.get(['savedArtists', 'savedArtistsData']);

  // Check both slug and display name for backward compat with pre-migration data
  const existingIndex = savedArtists.indexOf(key);
  const legacyIndex = key !== currentArtist ? savedArtists.indexOf(currentArtist) : -1;
  const index = existingIndex !== -1 ? existingIndex : legacyIndex;

  if (index >= 0) {
    const removedKey = savedArtists[index];
    savedArtists.splice(index, 1);
    delete savedArtistsData[removedKey];
    // Remove from server if logged in
    removeArtistFromServer(removedKey);
  } else {
    savedArtists.push(key);
    const artistData = {
      platforms: [],
      socialLinks: [],
      location: currentLocation || null,
      name: currentArtist, // preserve display name for rendering
      slug: slug || '',
    };

    // Save platforms
    if (currentResults && currentResults.length > 0) {
      for (const result of currentResults) {
        if (result.platforms && Array.isArray(result.platforms)) {
          for (const p of result.platforms) {
            artistData.platforms.push({ sourceId: p.sourceId, url: p.url });
          }
        }
      }
    }

    // Save social links
    if (currentSocialLinks && currentSocialLinks.length > 0) {
      artistData.socialLinks = currentSocialLinks;
    }

    // Save image URL from the claimed/first result if available
    const bestResult = currentResults && currentResults.find(r => r.type === 'artist');
    if (bestResult && bestResult.imageUrl) {
      artistData.imageUrl = bestResult.imageUrl;
    }

    savedArtistsData[key] = artistData;
    // Save to server if logged in
    saveArtistToServer(key, artistData);
  }

  await chrome.storage.local.set({ savedArtists, savedArtistsData });
  updateSaveButton();
  loadSavedArtists();
}

// Load saved artists
async function loadSavedArtists() {
  // Show loading state
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'loading';
  loadingDiv.textContent = 'Loading saved artists...';
  elements.savedArtistsList.replaceChildren(loadingDiv);

  const { savedArtists = [] } = await chrome.storage.local.get('savedArtists');
  const { savedArtistsData = {} } = await chrome.storage.local.get('savedArtistsData');

  if (savedArtists.length === 0) {
    elements.savedArtistsList.replaceChildren();
    elements.noSavedArtists.style.display = 'block';
    return;
  }

  elements.noSavedArtists.style.display = 'none';

  const fragment = document.createDocumentFragment();
  savedArtists.forEach(artist => {
    const artistData = savedArtistsData[artist] || {};
    const platforms = artistData.platforms || [];
    const socialLinks = artistData.socialLinks || [];
    const location = artistData.location || null;
    const imageUrl = artistData.imageUrl || null;

    const card = document.createElement('div');
    card.className = 'saved-artist-card';

    // Header with name and remove button
    const header = document.createElement('div');
    header.className = 'saved-artist-header';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'saved-artist-name-wrap';

    // Artist image (if available from server sync)
    // Restrict to https:// only for defense-in-depth
    const safeImageUrl = imageUrl && imageUrl.startsWith('https://') ? imageUrl : '';
    if (safeImageUrl) {
      const img = document.createElement('img');
      img.src = safeImageUrl;
      img.alt = '';
      img.className = 'saved-artist-img';
      img.loading = 'lazy';
      nameWrap.appendChild(img);
    }

    const nameLocationWrap = document.createElement('div');
    nameLocationWrap.className = 'name-location';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'saved-artist-name';
    // Use the synced name if available, otherwise fall back to the key
    nameSpan.textContent = artistData.name || artist;
    nameSpan.addEventListener('click', () => {
      switchToTab('discover');
      searchArtist(artist);
    });
    nameLocationWrap.appendChild(nameSpan);

    const locationText = formatLocation(location);
    if (locationText) {
      const locationSpan = document.createElement('div');
      locationSpan.className = 'saved-artist-location';
      locationSpan.textContent = locationText;
      nameLocationWrap.appendChild(locationSpan);
    }

    nameWrap.appendChild(nameLocationWrap);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'saved-artist-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', () => removeSavedArtist(artist));

    header.appendChild(nameWrap);
    header.appendChild(removeBtn);
    card.appendChild(header);

    // Platform links
    if (platforms.length > 0) {
      const platformsDiv = document.createElement('div');
      platformsDiv.className = 'saved-artist-platforms';

      // Filter to non-social, non-search platforms
      const relevantPlatforms = platforms.filter(p =>
        !isSocialSource(p.sourceId) && !isSearchOnlySource(p.sourceId, p.url)
      );

      // Deduplicate by sourceId
      const seen = new Set();
      const uniquePlatforms = relevantPlatforms.filter(p => {
        if (seen.has(p.sourceId)) return false;
        seen.add(p.sourceId);
        return true;
      });

      uniquePlatforms.slice(0, 5).forEach(p => {
        const config = SOURCE_CONFIG[p.sourceId] || { icon: '🔗', name: p.sourceId };
        const link = document.createElement('a');
        link.href = p.url;
        link.target = '_blank';
        link.className = 'platform-link';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'platform-icon';
        iconSpan.textContent = config.icon;

        link.appendChild(iconSpan);
        link.appendChild(document.createTextNode(config.name));
        platformsDiv.appendChild(link);
      });

      card.appendChild(platformsDiv);
    }

    // Social links
    if (socialLinks.length > 0) {
      const socialDiv = document.createElement('div');
      socialDiv.className = 'saved-artist-social';

      socialLinks.forEach(link => {
        const anchor = document.createElement('a');
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.className = 'social-link-small';
        anchor.title = link.platform;

        const iconSvg = SOCIAL_ICONS[link.platform];
        if (iconSvg) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(iconSvg, 'image/svg+xml');
          anchor.appendChild(doc.documentElement);
        }
        socialDiv.appendChild(anchor);
      });

      card.appendChild(socialDiv);
    }

    fragment.appendChild(card);
  });

  elements.savedArtistsList.replaceChildren(fragment);
}

// Remove saved artist
async function removeSavedArtist(artist) {
  const { savedArtists = [] } = await chrome.storage.local.get('savedArtists');
  const { savedArtistsData = {} } = await chrome.storage.local.get('savedArtistsData');
  const index = savedArtists.indexOf(artist);

  if (index >= 0) {
    savedArtists.splice(index, 1);
    delete savedArtistsData[artist];
    await chrome.storage.local.set({ savedArtists, savedArtistsData });
    // Remove from server if logged in
    removeArtistFromServer(artist);
    loadSavedArtists();
    updateSaveButton();
  }
}

// Load new releases for saved artists
async function loadNewReleases() {
  // Show loading state
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'loading';
  loadingDiv.textContent = 'Checking releases...';
  elements.newReleases.replaceChildren(loadingDiv);

  try {
    newReleases = await chrome.runtime.sendMessage({ type: 'GET_NEW_RELEASES' }) || [];
  } catch {
    newReleases = [];
  }
  renderNewReleases();
}

// Render new releases section
function renderNewReleases() {
  if (newReleases.length === 0) {
    elements.releasesSection.classList.add('hidden');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const release of newReleases) {
    const div = document.createElement('div');
    div.className = 'new-release-item';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'release-info';

    const artistSpan = document.createElement('span');
    artistSpan.className = 'release-artist';
    artistSpan.textContent = release.artistName;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'release-title';
    titleSpan.textContent = release.releaseName;

    const platformBadge = document.createElement('span');
    platformBadge.className = 'release-platform';
    platformBadge.textContent = release.platform;

    infoDiv.appendChild(artistSpan);
    infoDiv.appendChild(titleSpan);
    infoDiv.appendChild(platformBadge);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'release-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'release-open';
    openBtn.title = 'Listen';
    openBtn.textContent = 'Listen';
    openBtn.addEventListener('click', () => {
      if (isAllowedReleaseUrl(release.releaseUrl)) {
        chrome.tabs.create({ url: release.releaseUrl });
      }
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'release-dismiss';
    dismissBtn.title = 'Dismiss';
    dismissBtn.textContent = '\u00D7';
    dismissBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DISMISS_RELEASE', releaseId: release.id });
      loadNewReleases();
    });

    actionsDiv.appendChild(openBtn);
    actionsDiv.appendChild(dismissBtn);

    div.appendChild(infoDiv);
    div.appendChild(actionsDiv);
    fragment.appendChild(div);
  }

  elements.newReleases.replaceChildren(fragment);
  elements.releasesSection.classList.remove('hidden');
}

// Load last check time
async function loadLastCheckTime() {
  const { releaseCheckState = {} } = await chrome.storage.local.get('releaseCheckState');
  if (releaseCheckState.lastCheckDate) {
    const date = new Date(releaseCheckState.lastCheckDate);
    elements.lastCheckTime.textContent = `Last checked: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  }
}

// Check for releases now
async function checkReleasesNow() {
  elements.checkNowBtn.disabled = true;
  elements.checkNowBtn.classList.add('checking');
  elements.checkNowBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinning">
      <polyline points="23 4 23 10 17 10"></polyline>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
    </svg>
    Checking...
  `;

  try {
    const result = await chrome.runtime.sendMessage({ type: 'CHECK_RELEASES_NOW' });
    await loadNewReleases();
    await loadLastCheckTime();

    if (result && result.newCount > 0) {
      elements.checkNowBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Found ${result.newCount} new release${result.newCount > 1 ? 's' : ''}!
      `;
    } else {
      elements.checkNowBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        No new releases
      `;
    }
  } catch (error) {
    console.error('Check failed:', error);
    elements.checkNowBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="15" y1="9" x2="9" y2="15"></line>
        <line x1="9" y1="9" x2="15" y2="15"></line>
      </svg>
      Check failed
    `;
  }

  setTimeout(() => {
    elements.checkNowBtn.disabled = false;
    elements.checkNowBtn.classList.remove('checking');
    elements.checkNowBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"></polyline>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
      </svg>
      Check for New Releases
    `;
  }, 3000);
}

// Switch to tab
function switchToTab(tabName) {
  elements.tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  elements.tabPanels.forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

// Manual search (with in-flight guard to prevent API spam)
let searchInFlight = false;

async function searchArtist(artist) {
  if (!artist || searchInFlight) return;

  searchInFlight = true;
  elements.searchBtn.disabled = true;
  elements.searchInput.disabled = true;

  try {
    showNowPlaying({ artist, title: '', source: 'search' });
    await loadResults(artist);
    await loadEnrichment(artist);
  } finally {
    searchInFlight = false;
    elements.searchBtn.disabled = false;
    elements.searchInput.disabled = false;
  }
}

// Open in browser
function openInBrowser() {
  if (!currentArtist) return;
  const encodedQuery = encodeURIComponent(currentArtist);
  chrome.tabs.create({ url: `https://unstream.stream/?q=${encodedQuery}` });
}

// Report issue
function reportIssue(e) {
  e.preventDefault();
  if (!currentArtist) return;

  let platformList = 'No platforms found';
  if (currentResults && currentResults.length > 0) {
    const platforms = [];
    for (const result of currentResults) {
      if (result.platforms && Array.isArray(result.platforms)) {
        for (const platform of result.platforms) {
          platforms.push(`- ${platform.sourceId}: ${platform.url || 'N/A'}`);
        }
      }
    }
    if (platforms.length > 0) {
      platformList = platforms.join('\n');
    }
  }

  const subject = encodeURIComponent(`Issue Report: ${currentArtist}`);
  const body = encodeURIComponent(`Artist/Result: ${currentArtist}

Platforms:
${platformList}

Issue Description:
[Please describe what's wrong with this result]`);

  chrome.tabs.create({ url: `mailto:support@unstream.stream?subject=${subject}&body=${body}` });
}

// Setup event listeners
function setupEventListeners() {
  // Tab navigation
  elements.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
  });

  // Save artist
  elements.saveArtistBtn.addEventListener('click', toggleSaveArtist);

  // Open in browser
  elements.openBrowserBtn.addEventListener('click', openInBrowser);

  // Report issue
  elements.reportIssueLink.addEventListener('click', reportIssue);

  // Check now button
  elements.checkNowBtn.addEventListener('click', checkReleasesNow);

  // Artist notifications toggle
  const notifToggle = document.getElementById('artist-notifications-toggle');
  notifToggle.addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ artistNotifications: e.target.checked });
  });

  // Manual search
  elements.searchBtn.addEventListener('click', () => {
    searchArtist(elements.searchInput.value.trim());
  });

  elements.searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      searchArtist(elements.searchInput.value.trim());
    }
  });

  // Auth form submission
  elements.authForm.addEventListener('submit', handleSignIn);

  // Magic link button
  elements.authMagicLink.addEventListener('click', () => {
    const email = elements.authEmail.value.trim();
    if (email) {
      handleMagicLink(email);
    }
  });

  // Sign out button
  elements.authSignOut.addEventListener('click', handleSignOut);

  // Sync now button
  elements.syncNowBtn.addEventListener('click', syncSavedArtists);
}

// Initialize
init();
