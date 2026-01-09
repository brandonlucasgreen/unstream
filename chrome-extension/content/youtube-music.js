// Unstream Chrome Extension - YouTube Music Detection

(function() {
  'use strict';

  const POLL_INTERVAL = 3000;
  let lastArtist = null;
  let lastTitle = null;

  // Get now playing info from YouTube Music
  function getNowPlaying() {
    // Try Media Session API first
    if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
      const { title, artist } = navigator.mediaSession.metadata;
      if (artist && title) {
        return { artist, title };
      }
    }

    // Fallback: DOM scraping
    // YouTube Music player bar at bottom
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return null;

    // Song title
    const titleElement = playerBar.querySelector('.title.ytmusic-player-bar');
    // Artist name
    const artistElement = playerBar.querySelector('.byline.ytmusic-player-bar a');

    if (!titleElement || !artistElement) return null;

    const title = titleElement.textContent?.trim();
    const artist = artistElement.textContent?.trim();

    if (!title || !artist) return null;

    return { artist, title };
  }

  // Check if music is playing
  function isPlaying() {
    const video = document.querySelector('video');
    return video && !video.paused;
  }

  // Poll for changes
  function poll() {
    if (!isPlaying()) {
      if (lastArtist !== null) {
        chrome.runtime.sendMessage({ type: 'MUSIC_STOPPED' });
        lastArtist = null;
        lastTitle = null;
      }
      return;
    }

    const nowPlaying = getNowPlaying();
    if (!nowPlaying) return;

    const { artist, title } = nowPlaying;

    if (artist !== lastArtist || title !== lastTitle) {
      lastArtist = artist;
      lastTitle = title;

      chrome.runtime.sendMessage({
        type: 'MUSIC_DETECTED',
        data: { artist, title, source: 'youtube-music' }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll();

  console.log('[Unstream] YouTube Music content script loaded');
})();
