// Unstream Chrome Extension - Generic Music Detection
// Uses Media Session API to detect music on any website

(function() {
  'use strict';

  const POLL_INTERVAL = 3000; // Check every 3 seconds
  let lastArtist = null;
  let lastTitle = null;

  // Map common music domains to friendly source names
  const DOMAIN_SOURCE_MAP = {
    'bandcamp.com': 'bandcamp',
    'soundcloud.com': 'soundcloud',
    'tidal.com': 'tidal',
    'deezer.com': 'deezer',
    'pandora.com': 'pandora',
    'amazon.com': 'amazon music',
    'music.amazon.com': 'amazon music',
    'audius.co': 'audius',
    'qobuz.com': 'qobuz',
    'last.fm': 'last.fm',
    'mixcloud.com': 'mixcloud',
    'audiomack.com': 'audiomack',
    'beatport.com': 'beatport',
    'napster.com': 'napster',
    'iheart.com': 'iheartradio',
    'tunein.com': 'tunein',
    'radio.com': 'radio.com',
    'anghami.com': 'anghami',
    'jiosaavn.com': 'jiosaavn',
    'gaana.com': 'gaana',
    'wynk.in': 'wynk',
    'boomplay.com': 'boomplay',
    'resonate.is': 'resonate'
  };

  // Get friendly source name from hostname
  function getSourceName() {
    const hostname = window.location.hostname.toLowerCase();

    // Check for exact match or subdomain match
    for (const [domain, source] of Object.entries(DOMAIN_SOURCE_MAP)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return source;
      }
    }

    // Special case for Bandcamp artist subdomains (artist.bandcamp.com)
    if (hostname.endsWith('.bandcamp.com')) {
      return 'bandcamp';
    }

    // Fallback: use hostname without www prefix
    return hostname.replace(/^www\./, '');
  }

  // Extract now playing info from Media Session API
  function getNowPlaying() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.metadata) {
      return null;
    }

    const { title, artist } = navigator.mediaSession.metadata;

    if (!title || !artist) {
      return null;
    }

    return { artist, title };
  }

  // Check if media is currently playing
  function isPlaying() {
    // First check Media Session playback state
    if ('mediaSession' in navigator && navigator.mediaSession.playbackState === 'playing') {
      return true;
    }

    // Fallback: check for any playing audio/video elements
    const mediaElements = document.querySelectorAll('audio, video');
    for (const media of mediaElements) {
      if (!media.paused && !media.ended && media.readyState > 2) {
        return true;
      }
    }

    return false;
  }

  // Poll for changes
  function poll() {
    if (!isPlaying()) {
      if (lastArtist !== null) {
        // Music stopped
        chrome.runtime.sendMessage({ type: 'MUSIC_STOPPED' });
        lastArtist = null;
        lastTitle = null;
      }
      return;
    }

    const nowPlaying = getNowPlaying();
    if (!nowPlaying) return;

    const { artist, title } = nowPlaying;

    // Only send if changed
    if (artist !== lastArtist || title !== lastTitle) {
      lastArtist = artist;
      lastTitle = title;

      chrome.runtime.sendMessage({
        type: 'MUSIC_DETECTED',
        data: { artist, title, source: getSourceName() }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);

  // Also check immediately
  poll();

  console.log('[Unstream] Generic content script loaded for', getSourceName());
})();
