// Unstream Chrome Extension - Bandcamp Detection
// Handles *.bandcamp.com and custom-domain Bandcamp sites

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

  // Extract now playing from Bandcamp's inline player (album/track pages)
  function getFromInlinePlayer() {
    // Check the main track page player
    const trackTitle = document.querySelector('.trackTitle');
    const artistName =
      document.querySelector('#name-section a') ||
      document.querySelector('#band-name-location .title');

    if (trackTitle && artistName) {
      const title = trackTitle.textContent?.trim();
      const artist = artistName.textContent?.trim();
      if (title && artist) return { artist, title };
    }

    return null;
  }

  // Extract now playing from the bottom playback bar (collection/feed pages)
  function getFromPlaybackBar() {
    // The persistent player bar at the bottom of the page
    const playerInfo = document.querySelector('.now-playing');
    if (!playerInfo) return null;

    const titleEl = playerInfo.querySelector('.title');
    const artistEl = playerInfo.querySelector('.artist');

    if (titleEl && artistEl) {
      const title = titleEl.textContent?.trim();
      const artist = artistEl.textContent?.trim();
      if (title && artist) return { artist, title };
    }

    return null;
  }

  // Extract from the collection player (bandcamp.com/username)
  function getFromCollectionPlayer() {
    const trackTitle = document.querySelector('.collection-player .title');
    const trackArtist = document.querySelector('.collection-player .artist');

    if (trackTitle && trackArtist) {
      const title = trackTitle.textContent?.trim();
      const artist = trackArtist.textContent?.trim();
      if (title && artist) return { artist, title };
    }

    return null;
  }

  // Get now playing info using all available methods
  function getNowPlaying() {
    return getFromMediaSession()
      || getFromInlinePlayer()
      || getFromPlaybackBar()
      || getFromCollectionPlayer();
  }

  // Check if audio is currently playing
  function isPlaying() {
    // Check Media Session playback state
    if ('mediaSession' in navigator && navigator.mediaSession.playbackState === 'playing') {
      return true;
    }

    // Fallback: check audio elements
    const audioElements = document.querySelectorAll('audio');
    for (const audio of audioElements) {
      if (!audio.paused && !audio.ended && audio.readyState > 2) {
        return true;
      }
    }

    // Check for play/pause button state (Bandcamp uses a play button that changes)
    const playingButton = document.querySelector('.playbutton.playing, .play-btn.playing');
    if (playingButton) return true;

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
        data: { artist, title, source: 'bandcamp' }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll();

  console.log('[Unstream] Bandcamp content script loaded');
})();
