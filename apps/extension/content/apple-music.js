// Unstream Chrome Extension - Apple Music Web Detection

(function() {
  'use strict';

  const POLL_INTERVAL = 3000;
  let lastArtist = null;
  let lastTitle = null;

  // Get now playing info from Apple Music Web
  function getNowPlaying() {
    // Try Media Session API first
    if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
      const { title, artist } = navigator.mediaSession.metadata;
      if (artist && title) {
        return { artist, title };
      }
    }

    // Fallback: DOM scraping
    // Apple Music web player LCD display
    const lcd = document.querySelector('.web-chrome-playback-lcd__song-name-scroll-inner');
    const artistContainer = document.querySelector('.web-chrome-playback-lcd__sub-copy-scroll-inner');

    if (!lcd || !artistContainer) {
      // Try alternative selectors
      const altTitle = document.querySelector('[data-testid="lcd-song-name"]');
      const altArtist = document.querySelector('[data-testid="lcd-artist-name"]');

      if (altTitle && altArtist) {
        return {
          title: altTitle.textContent?.trim(),
          artist: altArtist.textContent?.trim()
        };
      }

      return null;
    }

    const title = lcd.textContent?.trim();
    // Artist container may have "Artist - Album", we want just artist
    const artistText = artistContainer.textContent?.trim();
    const artist = artistText?.split(' — ')[0]?.trim();

    if (!title || !artist) return null;

    return { artist, title };
  }

  // Check if music is playing
  function isPlaying() {
    // Check for pause button
    const pauseButton = document.querySelector('[data-testid="pause-button"]');
    if (pauseButton) return true;

    // Alternative: check audio element
    const audio = document.querySelector('audio');
    return audio && !audio.paused;
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
        data: { artist, title, source: 'apple-music' }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll();

  console.log('[Unstream] Apple Music content script loaded');
})();
