// Unstream - Apple Music Web Detection

(function() {
  'use strict';
  const { createPoller, getFromMediaSession } = window.Unstream;

  function getNowPlaying() {
    const ms = getFromMediaSession();
    if (ms) return ms;

    const lcd = document.querySelector('.web-chrome-playback-lcd__song-name-scroll-inner');
    const artistContainer = document.querySelector('.web-chrome-playback-lcd__sub-copy-scroll-inner');

    if (lcd && artistContainer) {
      const title = lcd.textContent?.trim();
      const artistText = artistContainer.textContent?.trim();
      const artist = artistText?.split(' — ')[0]?.trim();
      if (title && artist) return { artist, title };
    }

    // Alternative selectors
    const altTitle = document.querySelector('[data-testid="lcd-song-name"]');
    const altArtist = document.querySelector('[data-testid="lcd-artist-name"]');
    if (altTitle && altArtist) {
      const title = altTitle.textContent?.trim();
      const artist = altArtist.textContent?.trim();
      if (title && artist) return { artist, title };
    }

    return null;
  }

  function isPlaying() {
    if (document.querySelector('[data-testid="pause-button"]')) return true;
    const audio = document.querySelector('audio');
    return audio && !audio.paused;
  }

  createPoller({ getNowPlaying, isPlaying, source: 'apple-music' });
})();
