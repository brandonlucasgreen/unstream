// Unstream - Bandcamp Detection
// Handles *.bandcamp.com and custom-domain Bandcamp sites

(function() {
  'use strict';
  const { createPoller, getFromMediaSession, isMediaSessionPlaying, isMediaElementPlaying } = window.Unstream;

  function getFromInlinePlayer() {
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

  function getFromPlaybackBar() {
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

  function getFromCollectionPlayer() {
    const titleEl = document.querySelector('.collection-player .title');
    const artistEl = document.querySelector('.collection-player .artist');
    if (titleEl && artistEl) {
      const title = titleEl.textContent?.trim();
      const artist = artistEl.textContent?.trim();
      if (title && artist) return { artist, title };
    }
    return null;
  }

  function getNowPlaying() {
    return getFromMediaSession()
      || getFromInlinePlayer()
      || getFromPlaybackBar()
      || getFromCollectionPlayer();
  }

  function isPlaying() {
    if (isMediaSessionPlaying()) return true;
    if (isMediaElementPlaying('audio')) return true;
    return !!document.querySelector('.playbutton.playing, .play-btn.playing');
  }

  createPoller({ getNowPlaying, isPlaying, source: 'bandcamp' });
})();
