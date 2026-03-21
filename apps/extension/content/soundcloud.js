// Unstream Chrome Extension - SoundCloud Detection

(function() {
  'use strict';

  const POLL_INTERVAL = 3000;
  let lastArtist = null;
  let lastTitle = null;

  // Safe wrapper for chrome.runtime.sendMessage
  function safeSendMessage(message) {
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage(message);
      }
    } catch (e) {
      // Extension context invalidated — ignore
    }
  }

  // Extract now playing info from Media Session API
  function getFromMediaSession() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.metadata) {
      return null;
    }

    const { title, artist } = navigator.mediaSession.metadata;
    if (!title || !artist) return null;

    return { artist, title };
  }

  // Extract from SoundCloud's bottom playback bar
  function getFromPlaybackBar() {
    // The persistent player controls at the bottom
    const playbackBar = document.querySelector('.playControls__soundBadge');
    if (!playbackBar) return null;

    const titleEl = playbackBar.querySelector('.playbackSoundBadge__titleLink');
    const artistEl = playbackBar.querySelector('.playbackSoundBadge__lightLink');

    if (titleEl && artistEl) {
      // SoundCloud uses title attributes for the full untruncated text
      const title = titleEl.getAttribute('title') || titleEl.textContent?.trim();
      const artist = artistEl.getAttribute('title') || artistEl.textContent?.trim();
      if (title && artist) return { artist, title };
    }

    return null;
  }

  // Extract from the currently visible track page
  function getFromTrackPage() {
    // On a single track page
    const titleEl = document.querySelector('.soundTitle__title span');
    const artistEl = document.querySelector('.soundTitle__usernameText');

    if (titleEl && artistEl) {
      const title = titleEl.textContent?.trim();
      const artist = artistEl.textContent?.trim();
      if (title && artist) return { artist, title };
    }

    return null;
  }

  // Get now playing info using all available methods
  function getNowPlaying() {
    return getFromMediaSession()
      || getFromPlaybackBar()
      || getFromTrackPage();
  }

  // Check if audio is currently playing
  function isPlaying() {
    // Check Media Session playback state
    if ('mediaSession' in navigator && navigator.mediaSession.playbackState === 'playing') {
      return true;
    }

    // Check for SoundCloud's playing state on the play button
    const playButton = document.querySelector('.playControls__play');
    if (playButton && playButton.classList.contains('playing')) {
      return true;
    }

    // Fallback: check audio elements
    const audioElements = document.querySelectorAll('audio');
    for (const audio of audioElements) {
      if (!audio.paused && !audio.ended && audio.readyState > 2) {
        return true;
      }
    }

    return false;
  }

  // Poll for changes
  function poll() {
    if (!isPlaying()) {
      if (lastArtist !== null) {
        safeSendMessage({ type: 'MUSIC_STOPPED' });
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

      safeSendMessage({
        type: 'MUSIC_DETECTED',
        data: { artist, title, source: 'soundcloud' }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll();

  // SoundCloud is an SPA — listen for URL changes
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Reset and re-poll on navigation
      lastArtist = null;
      lastTitle = null;
      setTimeout(poll, 500);
      setTimeout(poll, 1500);
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  console.log('[Unstream] SoundCloud content script loaded');
})();
