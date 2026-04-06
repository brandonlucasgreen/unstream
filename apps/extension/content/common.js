// Unstream - Shared content script utilities
// Provides polling infrastructure, message passing, and common detection helpers.
// Each platform script defines getNowPlaying(), isPlaying(), and source,
// then calls Unstream.createPoller() to start detection.

window.Unstream = (function() {
  'use strict';

  function safeSendMessage(message) {
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage(message);
      }
    } catch (e) {
      // Extension context invalidated (service worker inactive) — ignore
    }
  }

  // Read Media Session metadata (used by most platform scripts)
  function getFromMediaSession() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.metadata) {
      return null;
    }
    const { title, artist } = navigator.mediaSession.metadata;
    if (!title || !artist) return null;
    return { artist, title };
  }

  // Check Media Session playback state
  function isMediaSessionPlaying() {
    return 'mediaSession' in navigator && navigator.mediaSession.playbackState === 'playing';
  }

  // Check if any audio/video element is actively playing
  function isMediaElementPlaying(selector) {
    const elements = document.querySelectorAll(selector || 'audio, video');
    for (const el of elements) {
      if (!el.paused && !el.ended && el.readyState > 2) return true;
    }
    return false;
  }

  // Guard against multiple pollers if the content script is re-injected
  let activePollerSource = null;

  // Creates and starts the polling loop. Returns reset(), poll(), and stop() functions.
  function createPoller({ getNowPlaying, isPlaying, source }) {
    // Prevent duplicate pollers for the same source
    if (activePollerSource === source) {
      return { reset() {}, poll() {}, stop() {} };
    }
    activePollerSource = source;

    const POLL_INTERVAL = 3000;
    let lastArtist = null;
    let lastTitle = null;
    let intervalId = null;

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
          data: { artist, title, source }
        });
      }
    }

    intervalId = setInterval(poll, POLL_INTERVAL);
    poll();

    // Return helpers for SPA navigation handling
    return {
      reset() {
        lastArtist = null;
        lastTitle = null;
      },
      poll,
      stop() {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
        activePollerSource = null;
      }
    };
  }

  return { createPoller, getFromMediaSession, isMediaSessionPlaying, isMediaElementPlaying };
})();
