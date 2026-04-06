// Unstream - Spotify Web Player Detection

(function() {
  'use strict';
  const { createPoller, getFromMediaSession } = window.Unstream;

  function getNowPlaying() {
    // Media Session is the preferred primary source. The DOM selectors below
    // are fragile and may break when Spotify updates their web player markup.
    const ms = getFromMediaSession();
    if (ms) return ms;

    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    if (!widget) return null;

    const artistLink = widget.querySelector('[data-testid="context-item-info-artist"]');
    const titleLink = widget.querySelector('[data-testid="context-item-link"]');
    if (!artistLink || !titleLink) return null;

    const artist = artistLink.textContent?.trim();
    const title = titleLink.textContent?.trim();
    return (artist && title) ? { artist, title } : null;
  }

  function isPlaying() {
    return !!document.querySelector('[data-testid="control-button-pause"]');
  }

  createPoller({ getNowPlaying, isPlaying, source: 'spotify' });
})();
