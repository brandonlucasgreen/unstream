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

  // Playback signal for sites that publish Media Session metadata but give no
  // other sign of playing: playbackState left at "none", and audio played
  // through an element that isn't in the DOM (so isMediaElementPlaying can't
  // see it). xpn.org's live radio player is the case that prompted this.
  //
  // For those sites a *change* in the published track is taken to mean
  // "playing". The metadata present when the script starts is not enough on its
  // own, because some players fill it from the station's on-air feed before the
  // listener presses play. The signal stays off for any site that sets
  // playbackState itself, or once a DOM media element has been seen playing,
  // since those sites tell us the truth through the normal signals.
  //
  // Trade-off: once latched, a site whose metadata keeps updating after the
  // listener pauses will still be reported, and MUSIC_STOPPED only fires if the
  // site clears its metadata.
  function createMetadataPlaybackSignal() {
    const trackKey = (track) => (track ? `${track.artist}\u0000${track.title}` : null);
    const initialKey = trackKey(getFromMediaSession());
    let latched = false;
    let sawElementPlaying = false;

    return {
      noteElementPlaying() {
        sawElementPlaying = true;
      },
      isPlaying() {
        if (sawElementPlaying) return false;
        if (!('mediaSession' in navigator) || navigator.mediaSession.playbackState !== 'none') return false;
        const key = trackKey(getFromMediaSession());
        if (key === null) return false;
        if (key !== initialKey) latched = true;
        return latched;
      }
    };
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

  return {
    createPoller,
    createMetadataPlaybackSignal,
    getFromMediaSession,
    isMediaSessionPlaying,
    isMediaElementPlaying
  };
})();
