// Unstream Chrome Extension - Spotify Web Player Detection

(function() {
  'use strict';

  const POLL_INTERVAL = 3000; // Check every 3 seconds
  let lastArtist = null;
  let lastTitle = null;

  // Extract now playing info from Spotify Web Player
  function getNowPlaying() {
    // Try Media Session API first (most reliable)
    if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
      const { title, artist } = navigator.mediaSession.metadata;
      if (title && artist) {
        return { artist, title };
      }
    }

    // Fallback: DOM scraping
    // The now playing widget at the bottom of Spotify Web Player
    const nowPlayingWidget = document.querySelector('[data-testid="now-playing-widget"]');
    if (!nowPlayingWidget) return null;

    // Artist link
    const artistLink = nowPlayingWidget.querySelector('[data-testid="context-item-info-artist"]');
    // Track title
    const titleLink = nowPlayingWidget.querySelector('[data-testid="context-item-link"]');

    if (!artistLink || !titleLink) return null;

    const artist = artistLink.textContent?.trim();
    const title = titleLink.textContent?.trim();

    if (!artist || !title) return null;

    return { artist, title };
  }

  // Check if music is currently playing
  function isPlaying() {
    // Check for pause button (means music is playing)
    const pauseButton = document.querySelector('[data-testid="control-button-pause"]');
    return !!pauseButton;
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
        data: { artist, title, source: 'spotify' }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);

  // Also check immediately
  poll();

  console.log('[Unstream] Spotify content script loaded');
})();
