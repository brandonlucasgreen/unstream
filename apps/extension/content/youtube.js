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
    'ft.', 'feat.', 'featuring'
  ];

  // Check if this looks like a music video
  function isMusicVideo(title) {
    const titleLower = title.toLowerCase();
    return MUSIC_KEYWORDS.some(keyword => titleLower.includes(keyword));
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
      .trim();

    // Try "Artist - Title" pattern
    const dashMatch = cleanTitle.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (dashMatch) {
      const artist = dashMatch[1].trim();
      const song = dashMatch[2].trim();
      return { artist, title: song };
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

    // Fallback: Get video title
    const video = document.querySelector('video');
    if (!video || video.paused) return null;

    const titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    if (!titleElement) return null;

    const videoTitle = titleElement.textContent?.trim();
    if (!videoTitle) return null;

    // Check if it looks like a music video
    if (!isMusicVideo(videoTitle)) return null;

    // Try to extract artist
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
        chrome.runtime.sendMessage({ type: 'MUSIC_STOPPED' });
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

      chrome.runtime.sendMessage({
        type: 'MUSIC_DETECTED',
        data: { artist, title, source: 'youtube' }
      });
    }
  }

  // Start polling
  setInterval(poll, POLL_INTERVAL);
  poll();

  console.log('[Unstream] YouTube content script loaded');
})();
