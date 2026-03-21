// Unstream - YouTube Music Detection

(function() {
  'use strict';
  const { createPoller, getFromMediaSession } = window.Unstream;

  function getNowPlaying() {
    const ms = getFromMediaSession();
    if (ms) return ms;

    const playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) return null;

    const titleEl = playerBar.querySelector('.title.ytmusic-player-bar');
    const artistEl = playerBar.querySelector('.byline.ytmusic-player-bar a');
    if (!titleEl || !artistEl) return null;

    const title = titleEl.textContent?.trim();
    const artist = artistEl.textContent?.trim();
    return (title && artist) ? { artist, title } : null;
  }

  function isPlaying() {
    const video = document.querySelector('video');
    return video && !video.paused;
  }

  createPoller({ getNowPlaying, isPlaying, source: 'youtube-music' });
})();
