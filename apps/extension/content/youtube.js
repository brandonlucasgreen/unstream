// Unstream Chrome Extension - YouTube Detection

(function() {
  'use strict';

  const POLL_INTERVAL = 3000;
  let lastArtist = null;
  let lastTitle = null;

  // Music-related keywords in video titles
  const MUSIC_KEYWORDS = [
    'official video', 'official music video', 'music video',
    'official audio', 'audio', 'lyrics', 'lyric video',
    'visualizer', 'official visualizer',
    'live', 'acoustic', 'remix', 'cover',
    'ft.', 'feat.', 'featuring',
    'music', 'song', 'album', 'ep ', 'single',
    'prod.', 'produced by', 'beat',
    'mv', 'pmv'
  ];

  // Safe wrapper for chrome.runtime.sendMessage
  function safeSendMessage(message) {
    try {
      if (chrome.runtime?.id) {
        chrome.runtime.sendMessage(message);
      }
    } catch (e) {
      // Extension context invalidated (service worker inactive) — ignore
    }
  }

  // Check if this looks like a music video
  function isMusicVideo(title) {
    const titleLower = title.toLowerCase();
    return MUSIC_KEYWORDS.some(keyword => titleLower.includes(keyword));
  }

  // Check if the channel is a YouTube Music auto-generated "Topic" channel
  function isTopicChannel() {
    const channelElement = document.querySelector('#channel-name a');
    if (!channelElement) return false;
    const channelName = channelElement.textContent?.trim() || '';
    return channelName.endsWith(' - Topic');
  }

  // Check if the page has music category metadata
  function hasMusicCategory() {
    // Check structured data in the page
    const metaGenre = document.querySelector('meta[itemprop="genre"]');
    if (metaGenre) {
      const genre = metaGenre.getAttribute('content')?.toLowerCase() || '';
      if (genre === 'music' || genre.includes('music')) return true;
    }

    // Check for music-related badges/chips in the description
    const chips = document.querySelectorAll('yt-formatted-string.super-title');
    for (const chip of chips) {
      const text = chip.textContent?.toLowerCase() || '';
      if (text.includes('music')) return true;
    }

    return false;
  }

  // Extract artist from video title
  // Common patterns: "Artist - Song Title (Official Video)"
  function extractArtist(title) {
    // Remove common suffixes
    let cleanTitle = title
      .replace(/\(official.*?\)/gi, '')
      .replace(/\[official.*?\]/gi, '')
      .replace(/\(music video\)/gi, '')
      .replace(/\(audio\)/gi, '')
      .replace(/\(lyrics?\)/gi, '')
      .replace(/\(visualizer\)/gi, '')
      .replace(/\(live.*?\)/gi, '')
      .replace(/\(acoustic.*?\)/gi, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\(prod\..*?\)/gi, '')
      .replace(/\(feat\..*?\)/gi, '')
      .trim();

    // Try "Artist - Title" pattern (with various dash types and pipe)
    const dashMatch = cleanTitle.match(/^(.+?)\s*[-–—|]\s*(.+)$/);
    if (dashMatch) {
      const artist = dashMatch[1].trim();
      const song = dashMatch[2].trim();
      if (artist && song) {
        return { artist, title: song };
      }
    }

    // Try "Title by Artist" pattern
    const byMatch = cleanTitle.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) {
      return { artist: byMatch[2].trim(), title: byMatch[1].trim() };
    }

    return null;
  }

  // Get now playing info
  function getNowPlaying() {
    // Try Media Session API first
    if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
      const { title, artist } = navigator.mediaSession.metadata;
      if (artist && title) {
        return { artist, title };
      }
    }

    // Fallback: Get video title from DOM
    const video = document.querySelector('video');
    if (!video || video.paused) return null;

    // Try multiple selectors for the video title (YouTube updates DOM structure)
    const titleElement =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string') ||
      document.querySelector('#title h1 yt-formatted-string');
    if (!titleElement) return null;

    const videoTitle = titleElement.textContent?.trim();
    if (!videoTitle) return null;

    // Accept the video if any of these are true:
    // 1. Title contains music keywords
    // 2. It's a Topic channel (auto-generated music)
    // 3. Page has music category metadata
    const looksLikeMusic = isMusicVideo(videoTitle) || isTopicChannel() || hasMusicCategory();
    if (!looksLikeMusic) return null;

    // Try to extract artist from title
    const extracted = extractArtist(videoTitle);
    if (extracted) {
      return extracted;
    }

    // Fall back to channel name as artist
    const channelElement = document.querySelector('#channel-name a');
    if (channelElement) {
      const channel = channelElement.textContent?.trim();
      // Remove common suffixes from channel names
      const artist = channel
        ?.replace(/\s*-\s*Topic$/i, '')
        ?.replace(/VEVO$/i, '')
        ?.trim();

      if (artist) {
        return { artist, title: videoTitle };
      }
    }

    return null;
  }

  // Check if video is playing
  function isPlaying() {
    const video = document.querySelector('video');
    return video && !video.paused;
  }

  // Poll for changes
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
        data: { artist, title, source: 'youtube' }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll();

  // Handle YouTube SPA navigation — re-poll immediately on page transitions
  // YouTube fires this custom event when navigating between videos
  document.addEventListener('yt-navigate-finish', () => {
    // Reset state so we detect the new video
    lastArtist = null;
    lastTitle = null;
    // Poll immediately after navigation, then again shortly after
    // (DOM may not be fully updated on the first try)
    poll();
    setTimeout(poll, 1000);
    setTimeout(poll, 2500);
  });

  // Also listen for popstate (back/forward navigation)
  window.addEventListener('popstate', () => {
    lastArtist = null;
    lastTitle = null;
    setTimeout(poll, 500);
  });

  console.log('[Unstream] YouTube content script loaded');
})();
