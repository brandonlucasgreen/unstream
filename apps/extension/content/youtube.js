// Unstream - YouTube Detection

(function() {
  'use strict';
  const { createPoller, getFromMediaSession } = window.Unstream;

  // Strong indicators: a single match is sufficient
  const STRONG_KEYWORDS = [
    'official video', 'official music video', 'music video',
    'official audio', 'lyric video', 'official visualizer',
    'ft.', 'feat.', 'featuring',
    'prod.', 'produced by',
    'mv', 'pmv'
  ];

  // Weak indicators: require two matches or combination with hasMusicCategory
  const WEAK_KEYWORDS = [
    'audio', 'lyrics', 'visualizer',
    'acoustic', 'remix', 'cover',
    'music', 'song', 'album', 'ep ', 'single',
  ];

  function isMusicVideo(title) {
    const lower = title.toLowerCase();
    if (STRONG_KEYWORDS.some(kw => lower.includes(kw))) return true;

    // For weak keywords, require at least two matches
    const weakMatches = WEAK_KEYWORDS.filter(kw => lower.includes(kw)).length;
    return weakMatches >= 2;
  }

  function isTopicChannel() {
    const el = document.querySelector('#channel-name a');
    return el && (el.textContent?.trim() || '').endsWith(' - Topic');
  }

  function hasMusicCategory() {
    const meta = document.querySelector('meta[itemprop="genre"]');
    if (meta) {
      const genre = meta.getAttribute('content')?.toLowerCase() || '';
      if (genre.includes('music')) return true;
    }
    for (const chip of document.querySelectorAll('yt-formatted-string.super-title')) {
      if ((chip.textContent?.toLowerCase() || '').includes('music')) return true;
    }
    return false;
  }

  function extractArtist(title) {
    let clean = title
      .replace(/\(official.*?\)/gi, '')
      .replace(/\(music video\)/gi, '')
      .replace(/\(audio\)/gi, '')
      .replace(/\(lyrics?\)/gi, '')
      .replace(/\(visualizer\)/gi, '')
      .replace(/\(live.*?\)/gi, '')
      .replace(/\(acoustic.*?\)/gi, '')
      .replace(/\(prod\..*?\)/gi, '')
      .replace(/\(feat\..*?\)/gi, '')
      .replace(/\[.*?\]/g, '')
      .trim();

    const dashMatch = clean.match(/^(.+?)\s*[-–—|]\s*(.+)$/);
    if (dashMatch && dashMatch[1].trim() && dashMatch[2].trim()) {
      return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
    }

    const byMatch = clean.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) {
      return { artist: byMatch[2].trim(), title: byMatch[1].trim() };
    }

    return null;
  }

  function getNowPlaying() {
    const ms = getFromMediaSession();
    if (ms) return ms;

    const video = document.querySelector('video');
    if (!video || video.paused) return null;

    const titleElement =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string') ||
      document.querySelector('#title h1 yt-formatted-string');
    if (!titleElement) return null;

    const videoTitle = titleElement.textContent?.trim();
    if (!videoTitle) return null;

    // Require music signals: strong keyword match, topic channel, music
    // category, or a weak keyword match combined with music category
    const isMusic = isMusicVideo(videoTitle) || isTopicChannel() || hasMusicCategory();
    if (!isMusic) return null;

    const extracted = extractArtist(videoTitle);
    if (extracted) return extracted;

    const channelEl = document.querySelector('#channel-name a');
    if (channelEl) {
      const artist = channelEl.textContent?.trim()
        ?.replace(/\s*-\s*Topic$/i, '')
        ?.replace(/VEVO$/i, '')
        ?.trim();
      if (artist) return { artist, title: videoTitle };
    }

    return null;
  }

  function isPlaying() {
    const video = document.querySelector('video');
    return video && !video.paused;
  }

  const poller = createPoller({ getNowPlaying, isPlaying, source: 'youtube' });

  // Handle YouTube SPA navigation
  document.addEventListener('yt-navigate-finish', () => {
    poller.reset();
    poller.poll();
    setTimeout(poller.poll, 1000);
    setTimeout(poller.poll, 2500);
  });

  window.addEventListener('popstate', () => {
    poller.reset();
    setTimeout(poller.poll, 500);
  });
})();
