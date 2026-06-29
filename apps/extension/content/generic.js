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

  function getSourceName() {
    const hostname = window.location.hostname.toLowerCase();
    for (const [domain, source] of Object.entries(DOMAIN_SOURCE_MAP)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return source;
    }
    return hostname.replace(/^www\./, '');
  }

  function getNowPlaying() {
    return getFromMediaSession();
  }

  function isPlaying() {
    return isMediaSessionPlaying() || isMediaElementPlaying('audio, video');
  }

  createPoller({ getNowPlaying, isPlaying, source: getSourceName() });
})();
