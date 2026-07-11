// Unstream - Generic Music Detection
// Uses Media Session API to detect music on any website

(function() {
  'use strict';
  const { createPoller, getFromMediaSession, isMediaSessionPlaying, isMediaElementPlaying } = window.Unstream;

  const DOMAIN_SOURCE_MAP = {
    'tidal.com': 'tidal',
    'deezer.com': 'deezer',
    'pandora.com': 'pandora',
    'amazon.com': 'amazon music',
    'music.amazon.com': 'amazon music',
    'audius.co': 'audius',
    'qobuz.com': 'qobuz',
    'last.fm': 'last.fm',
    'mixcloud.com': 'mixcloud',
    'audiomack.com': 'audiomack',
    'beatport.com': 'beatport',
    'napster.com': 'napster',
    'iheart.com': 'iheartradio',
    'tunein.com': 'tunein',
    'radio.com': 'radio.com',
    'anghami.com': 'anghami',
    'jiosaavn.com': 'jiosaavn',
    'gaana.com': 'gaana',
    'wynk.in': 'wynk',
    'boomplay.com': 'boomplay',
    'resonate.is': 'resonate',
    'fairplayer.band': 'fairplayer'
  };

  // Faircamp's built-in player doesn't implement the Media Session API, so the
  // generic Media Session reader can't see it. Faircamp pages are identifiable
  // by their generator meta tag and share a stable template across every
  // self-hosted deployment, so we read the playing track straight from the DOM.
  // This is platform-wide detection keyed on the template — not per-site
  // scraping of an arbitrary hostname.
  function isFaircampPage() {
    const generator = document.querySelector('meta[name="generator"]');
    return !!generator && /^Faircamp\b/i.test(generator.content || '');
  }

  const IS_FAIRCAMP = isFaircampPage();

  function getFromFaircamp() {
    const active = document.querySelector('.track.active.playing')
      || document.querySelector('.track.active');
    if (!active) return null;
    const title = active.querySelector('.title')?.textContent?.trim();
    // Prefer a per-track artist (compilations); fall back to the release artist.
    const artist = (active.querySelector('.track_artists')?.textContent
      || document.querySelector('.release_artists')?.textContent || '').trim();
    if (!title || !artist) return null;
    return { artist, title };
  }

  function getSourceName() {
    if (IS_FAIRCAMP) return 'faircamp';
    const hostname = window.location.hostname.toLowerCase();
    for (const [domain, source] of Object.entries(DOMAIN_SOURCE_MAP)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return source;
    }
    return hostname.replace(/^www\./, '');
  }

  function getNowPlaying() {
    return getFromMediaSession() || (IS_FAIRCAMP ? getFromFaircamp() : null);
  }

  function isPlaying() {
    return isMediaSessionPlaying() || isMediaElementPlaying('audio, video');
  }

  createPoller({ getNowPlaying, isPlaying, source: getSourceName() });
})();
