// Unstream Chrome Extension - Popup Logic

// Source icons and names
const SOURCE_CONFIG = {
  bandcamp: { icon: '🎵', name: 'Bandcamp' },
  qobuz: { icon: '🎧', name: 'Qobuz' },
  jamcoop: { icon: '🎸', name: 'Jam.coop' },
  officialsite: { icon: '🌐', name: 'Official Site' },
  discogs: { icon: '📀', name: 'Discogs' },
  mirlo: { icon: '🪺', name: 'Mirlo' },
  faircamp: { icon: '⛺', name: 'Faircamp' },
  bandwagon: { icon: '🚐', name: 'Bandwagon' },
  nina: { icon: '🎵', name: 'Nina Protocol' },
  patreon: { icon: '🎨', name: 'Patreon' },
  kofi: { icon: '☕', name: 'Ko-fi' },
  buymeacoffee: { icon: '☕', name: 'Buy Me a Coffee' },
  ampwall: { icon: '🔊', name: 'Ampwall' },
  // Library
  hoopla: { icon: '📚', name: 'Hoopla' },
  freegal: { icon: '📚', name: 'Freegal' },
};

// Social icons (SVG paths)
const SOCIAL_ICONS = {
  instagram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
  tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
  threads: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.96-.065-1.182.408-2.256 1.332-3.023.88-.73 2.132-1.13 3.628-1.154 1.135-.018 2.187.086 3.146.31.002-.643-.034-1.25-.108-1.805-.222-1.67-.98-2.483-2.382-2.555-1.193-.026-2.178.396-2.623 1.165l-1.872-.897c.665-1.185 2.063-1.86 3.95-1.86h.094c1.208.025 2.25.358 3.095.99.949.712 1.508 1.755 1.66 3.1.07.625.102 1.314.095 2.054l.005.14c.928.477 1.674 1.09 2.215 1.823.773 1.049 1.073 2.32 1.012 3.691-.074 1.663-.707 3.193-1.839 4.434C18.587 23.081 15.915 23.98 12.186 24zm-.09-7.811c-1.076.02-1.892.263-2.427.723-.508.435-.763.989-.738 1.603.022.537.248.99.672 1.35.477.404 1.2.626 2.035.626.123 0 .247-.004.373-.013 1.2-.065 2.107-.474 2.696-1.218.504-.635.792-1.505.857-2.592-.77-.18-1.64-.292-2.586-.274-.29.006-.58.022-.882.022V16.19z"/></svg>',
  bluesky: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8z"/></svg>',
  mastodon: '<svg viewBox="0 0 24 24" fill="#858AFA"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>',
};

// DOM Elements
const elements = {
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
  proPrompt: document.getElementById('pro-prompt'),
  savedSection: document.getElementById('saved-section'),
  savedArtists: document.getElementById('saved-artists'),
  settingsPanel: document.getElementById('settings-panel'),
  settingsBtn: document.getElementById('settings-btn'),
  backBtn: document.getElementById('back-btn'),
  searchInput: document.getElementById('search-input'),
  searchBtn: document.getElementById('search-btn'),
  artistName: document.getElementById('artist-name'),
  trackTitle: document.getElementById('track-title'),
  sourceBadge: document.getElementById('source-badge'),
  licenseStatus: document.getElementById('license-status'),
  licenseKey: document.getElementById('license-key'),
  activateBtn: document.getElementById('activate-btn'),
};

// State
let currentArtist = null;
let currentResults = null;
let isProUser = false;

// Initialize popup
async function init() {
  // Check license status
  await checkLicense();

  // Get current track from storage
  const { currentTrack } = await chrome.storage.local.get('currentTrack');

  if (currentTrack && Date.now() - currentTrack.timestamp < 5 * 60 * 1000) {
    // Show current track if recent
    showNowPlaying(currentTrack);
    await loadResults(currentTrack.artist);
    await loadEnrichment(currentTrack.artist);
  }

  // Load saved artists if pro
  if (isProUser) {
    await loadSavedArtists();
  }

  // Setup event listeners
  setupEventListeners();
}

// Check license status
async function checkLicense() {
  const { license } = await chrome.storage.sync.get('license');

  if (license && license.status === 'active') {
    const lastValidated = license.validatedAt || 0;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    // Revalidate if older than 7 days
    if (Date.now() - lastValidated > sevenDays) {
      isProUser = await validateLicense(license.key);
    } else {
      isProUser = true;
    }
  }

  updateLicenseUI();
}

// Validate license with Lemon Squeezy
async function validateLicense(key) {
  try {
    const response = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        license_key: key,
      }),
    });

    const data = await response.json();

    if (data.valid) {
      await chrome.storage.sync.set({
        license: {
          key,
          status: 'active',
          validatedAt: Date.now(),
        },
      });
      return true;
    }
  } catch (error) {
    console.error('License validation error:', error);
  }

  return false;
}

// Update license UI
function updateLicenseUI() {
  const statusIcon = elements.licenseStatus.querySelector('.status-icon');
  const statusText = elements.licenseStatus.querySelector('.status-text');

  if (isProUser) {
    statusIcon.textContent = '●';
    statusText.textContent = 'Unstream Plus Active';
    elements.licenseStatus.classList.add('active');
    elements.proPrompt.classList.add('hidden');
  } else {
    statusIcon.textContent = '○';
    statusText.textContent = 'Free Plan';
    elements.licenseStatus.classList.remove('active');
    // Don't show proPrompt here - only show it when user tries to save
  }
}

// Show now playing
function showNowPlaying(track) {
  currentArtist = track.artist;
  elements.artistName.textContent = track.artist;
  elements.trackTitle.textContent = track.title || '';
  elements.sourceBadge.textContent = track.source;

  elements.nowPlaying.classList.remove('hidden');
  elements.idleState.classList.add('hidden');
  elements.actionsSection.classList.remove('hidden');

  updateSaveButton();
}

// Hide now playing
function hideNowPlaying() {
  currentArtist = null;
  currentResults = null;
  elements.nowPlaying.classList.add('hidden');
  elements.idleState.classList.remove('hidden');
  elements.resultsSection.classList.add('hidden');
  elements.socialSection.classList.add('hidden');
  elements.actionsSection.classList.add('hidden');
}

// Load results for artist
async function loadResults(artist) {
  elements.resultsGrid.innerHTML = '<div class="loading">Loading...</div>';
  elements.resultsSection.classList.remove('hidden');

  const response = await chrome.runtime.sendMessage({
    type: 'GET_RESULTS',
    artist,
  });

  if (response.error) {
    elements.resultsGrid.innerHTML = '<div class="error">Failed to load results</div>';
    return;
  }

  currentResults = response.results || [];
  renderResults(currentResults);
}

// Render results
function renderResults(results) {
  // Results are aggregated artist objects with platforms array
  // Flatten all platforms from all matching artists
  const allPlatforms = [];
  for (const result of results) {
    if (result.platforms && Array.isArray(result.platforms)) {
      for (const platform of result.platforms) {
        allPlatforms.push({
          sourceId: platform.sourceId,
          url: platform.url,
        });
      }
    }
  }

  // Filter out social links, search-only links, and duplicates
  const seen = new Set();
  const nonSocialPlatforms = allPlatforms.filter(p => {
    if (isSocialSource(p.sourceId)) return false;
    if (isSearchOnlySource(p.sourceId, p.url)) return false;
    if (seen.has(p.sourceId)) return false;
    seen.add(p.sourceId);
    return true;
  });

  if (nonSocialPlatforms.length === 0) {
    elements.resultsGrid.innerHTML = '<div class="empty">No alternative sources found</div>';
    return;
  }

  elements.resultsGrid.innerHTML = nonSocialPlatforms
    .slice(0, 8) // Limit to 8 results
    .map(platform => {
      const config = SOURCE_CONFIG[platform.sourceId] || { icon: '🔗', name: platform.sourceId };
      return `
        <a href="${platform.url}" target="_blank" class="result-item" title="${config.name}">
          <span class="result-icon">${config.icon}</span>
          <span class="result-name">${config.name}</span>
        </a>
      `;
    })
    .join('');
}

// Check if source is social
function isSocialSource(id) {
  return ['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon'].includes(id);
}

// Check if URL is a search URL vs a direct link
function isSearchUrl(url) {
  if (!url) return true;
  const lowercased = url.toLowerCase();
  const searchPatterns = ['/search', '?q=', '?query=', '/explore', 'duckduckgo.com'];
  return searchPatterns.some(pattern => lowercased.includes(pattern));
}

// Check if source is a manual search link (not a direct match)
// Now checks the actual URL to handle direct links from official sites
function isSearchOnlySource(id, url) {
  const searchOnlyIds = ['ampwall', 'nina', 'kofi', 'buymeacoffee'];
  if (!searchOnlyIds.includes(id)) return false;
  // If we have a direct link, it's not search-only
  return isSearchUrl(url);
}

// Load enrichment (MusicBrainz data)
async function loadEnrichment(artist) {
  const enrichment = await chrome.runtime.sendMessage({
    type: 'GET_ENRICHMENT',
    artist,
  });

  if (enrichment && enrichment.socialLinks && enrichment.socialLinks.length > 0) {
    renderSocialLinks(enrichment.socialLinks);
  }
}

// Render social links
function renderSocialLinks(links) {
  if (links.length === 0) return;

  elements.socialLinks.innerHTML = links
    .map(link => {
      const icon = SOCIAL_ICONS[link.platform] || '';
      return `
        <a href="${link.url}" target="_blank" class="social-link" title="${link.platform}">
          ${icon}
        </a>
      `;
    })
    .join('');

  elements.socialSection.classList.remove('hidden');
}

// Update save button state
async function updateSaveButton() {
  if (!currentArtist) return;

  const { savedArtists = [] } = await chrome.storage.sync.get('savedArtists');
  const isSaved = savedArtists.includes(currentArtist);

  if (isSaved) {
    elements.saveArtistBtn.innerHTML = '<span class="star">★</span> Saved';
    elements.saveArtistBtn.classList.add('saved');
  } else {
    elements.saveArtistBtn.innerHTML = '<span class="star">☆</span> Save Artist';
    elements.saveArtistBtn.classList.remove('saved');
  }
}

// Save/unsave artist
async function toggleSaveArtist() {
  if (!currentArtist) return;

  if (!isProUser) {
    // Show upgrade prompt
    elements.proPrompt.classList.remove('hidden');
    return;
  }

  const { savedArtists = [] } = await chrome.storage.sync.get('savedArtists');
  const index = savedArtists.indexOf(currentArtist);

  if (index >= 0) {
    savedArtists.splice(index, 1);
  } else {
    savedArtists.push(currentArtist);
  }

  await chrome.storage.sync.set({ savedArtists });
  updateSaveButton();
  loadSavedArtists();
}

// Load saved artists
async function loadSavedArtists() {
  if (!isProUser) {
    elements.savedSection.classList.add('hidden');
    return;
  }

  const { savedArtists = [] } = await chrome.storage.sync.get('savedArtists');

  if (savedArtists.length === 0) {
    elements.savedSection.classList.add('hidden');
    return;
  }

  elements.savedArtists.innerHTML = savedArtists
    .map(artist => `
      <div class="saved-artist" data-artist="${artist}">
        <span class="name">${artist}</span>
        <span class="remove" title="Remove">×</span>
      </div>
    `)
    .join('');

  elements.savedSection.classList.remove('hidden');

  // Add click handlers
  elements.savedArtists.querySelectorAll('.saved-artist').forEach(el => {
    el.querySelector('.name').addEventListener('click', () => {
      searchArtist(el.dataset.artist);
    });
    el.querySelector('.remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeSavedArtist(el.dataset.artist);
    });
  });
}

// Remove saved artist
async function removeSavedArtist(artist) {
  const { savedArtists = [] } = await chrome.storage.sync.get('savedArtists');
  const index = savedArtists.indexOf(artist);

  if (index >= 0) {
    savedArtists.splice(index, 1);
    await chrome.storage.sync.set({ savedArtists });
    loadSavedArtists();
    updateSaveButton();
  }
}

// Manual search
async function searchArtist(artist) {
  if (!artist) return;

  // Show as "now playing" for manual search
  showNowPlaying({ artist, title: '', source: 'search' });
  await loadResults(artist);
  await loadEnrichment(artist);
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

  // Build platform list from current results
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
  // Settings toggle
  elements.settingsBtn.addEventListener('click', () => {
    elements.settingsPanel.classList.remove('hidden');
    document.querySelectorAll('.section:not(#settings-panel)').forEach(s => s.classList.add('hidden'));
  });

  elements.backBtn.addEventListener('click', () => {
    elements.settingsPanel.classList.add('hidden');
    init(); // Refresh main view
  });

  // Save artist
  elements.saveArtistBtn.addEventListener('click', toggleSaveArtist);

  // Open in browser
  elements.openBrowserBtn.addEventListener('click', openInBrowser);

  // Report issue
  elements.reportIssueLink.addEventListener('click', reportIssue);

  // License activation
  elements.activateBtn.addEventListener('click', async () => {
    const key = elements.licenseKey.value.trim();
    if (!key) return;

    elements.activateBtn.textContent = 'Validating...';
    elements.activateBtn.disabled = true;

    isProUser = await validateLicense(key);
    updateLicenseUI();

    elements.activateBtn.textContent = isProUser ? 'Activated!' : 'Activate';
    elements.activateBtn.disabled = false;

    if (isProUser) {
      elements.licenseKey.value = '';
      loadSavedArtists();
    }
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

  // Upgrade link
  document.getElementById('upgrade-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://unstream.stream/plus' });
  });
}

// Initialize
init();
