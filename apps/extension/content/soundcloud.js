// Unstream - SoundCloud Detection

(function() {
  'use strict';
  const { createPoller, getFromMediaSession, isMediaSessionPlaying, isMediaElementPlaying } = window.Unstream;

  function getFromPlaybackBar() {
    const bar = document.querySelector('.playControls__soundBadge');
    if (!bar) return null;
    const titleEl = bar.querySelector('.playbackSoundBadge__titleLink');
    const artistEl = bar.querySelector('.playbackSoundBadge__lightLink');
    if (titleEl && artistEl) {
      const title = titleEl.getAttribute('title') || titleEl.textContent?.trim();
      const artist = artistEl.getAttribute('title') || artistEl.textContent?.trim();
      if (title && artist) return { artist, title };
    }
    return null;
  }

  function getFromTrackPage() {
    const titleEl = document.querySelector('.soundTitle__title span');
    const artistEl = document.querySelector('.soundTitle__usernameText');
    if (titleEl && artistEl) {
      const title = titleEl.textContent?.trim();
      const artist = artistEl.textContent?.trim();
      if (title && artist) return { artist, title };
    }
    return null;
  }

  function getNowPlaying() {
    return getFromMediaSession() || getFromPlaybackBar() || getFromTrackPage();
  }

  function isPlaying() {
    if (isMediaSessionPlaying()) return true;
    const playBtn = document.querySelector('.playControls__play');
    if (playBtn && playBtn.classList.contains('playing')) return true;
    return isMediaElementPlaying('audio');
  }

  const poller = createPoller({ getNowPlaying, isPlaying, source: 'soundcloud' });

  // SoundCloud is an SPA — poll for URL changes instead of using a
  // MutationObserver on document.body (which fires excessively).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      poller.reset();
      setTimeout(poller.poll, 500);
      setTimeout(poller.poll, 1500);
    }
  }, 1500);
})();
