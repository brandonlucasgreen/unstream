(function () {
  'use strict';

  // Derive base URL from this script's src so it works in both dev and production
  var scriptEl = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var BASE_URL = 'https://unstream.stream';
  if (scriptEl && scriptEl.src) {
    try {
      var scriptUrl = new URL(scriptEl.src);
      BASE_URL = scriptUrl.origin;
    } catch (e) { /* fall back to default */ }
  }

  // Platform metadata (subset of sources.ts)
  const platforms = {
    bandcamp: { name: 'Bandcamp', color: '#1da0c3', icon: '🎵' },
    mirlo: { name: 'Mirlo', color: '#6366f1', icon: '🪺' },
    ampwall: { name: 'Ampwall', color: '#ef4444', icon: '🔊' },
    bandwagon: { name: 'Bandwagon', color: '#8b5cf6', icon: '🚐' },
    faircamp: { name: 'Faircamp', color: '#22c55e', icon: '🏕️' },
    qobuz: { name: 'Qobuz', color: '#0170eb', icon: '🎧' },
    patreon: { name: 'Patreon', color: '#ff424d', icon: '🎨' },
    kofi: { name: 'Ko-fi', color: '#13c3ff', icon: '🍵' },
    buymeacoffee: { name: 'Buy Me a Coffee', color: '#ffdd00', icon: '☕' },
    officialsite: { name: 'Official Site', color: '#f59e0b', icon: '🌐' },
    discogs: { name: 'Discogs', color: '#333333', icon: '📀' },
    musicbrainz: { name: 'MusicBrainz', color: '#eb743b', icon: '🧠' },
    internetarchive: { name: 'Internet Archive', color: '#428bca', icon: '🏛️' },
    funkwhale: { name: 'Funkwhale', color: '#0084c7', icon: '🐋' },
    librefm: { name: 'Libre.fm', color: '#a40000', icon: '📻' },
    listenbrainz: { name: 'ListenBrainz', color: '#353070', icon: '👂' },
    instagram: { name: 'Instagram', color: '#E4405F', icon: '📷' },
    facebook: { name: 'Facebook', color: '#1877F2', icon: '📘' },
    tiktok: { name: 'TikTok', color: '#000000', icon: '🎬' },
    youtube: { name: 'YouTube', color: '#FF0000', icon: '▶️' },
    threads: { name: 'Threads', color: '#000000', icon: '🧵' },
    bluesky: { name: 'Bluesky', color: '#0085ff', icon: '🦋' },
    mastodon: { name: 'Mastodon', color: '#6364FF', icon: '🦣' },
    hoopla: { name: 'Hoopla', color: '#e86c2e', icon: '📚' },
    freegal: { name: 'Freegal', color: '#4caf50', icon: '🎶' },
    jamcoop: { name: 'Jam.coop', color: '#e91e63', icon: '🎸' },
  };

  // Categories to prioritize (non-social first)
  const priorityCategories = [
    'bandcamp', 'mirlo', 'ampwall', 'qobuz', 'faircamp', 'bandwagon',
    'patreon', 'kofi', 'buymeacoffee', 'officialsite',
    'funkwhale', 'internetarchive', 'discogs',
    'hoopla', 'freegal', 'jamcoop',
  ];

  function sortPlatforms(links) {
    return links.slice().sort(function (a, b) {
      var ai = priorityCategories.indexOf(a.sourceId);
      var bi = priorityCategories.indexOf(b.sourceId);
      if (ai === -1) ai = 999;
      if (bi === -1) bi = 999;
      return ai - bi;
    });
  }

  // Filter out search-only links (URLs pointing to search engines)
  function isDirectLink(link) {
    var url = link.url || '';
    return (
      url.indexOf('duckduckgo.com') === -1 &&
      url.indexOf('google.com/search') === -1 &&
      url.indexOf('searchStyle=search') === -1 &&
      url.indexOf('explore-creators') === -1
    );
  }

  function createWidget(container) {
    var artist = container.getAttribute('data-artist');
    var theme = container.getAttribute('data-theme') || 'dark';
    var maxLinks = parseInt(container.getAttribute('data-max-links') || '6', 10);

    if (!artist) {
      container.innerHTML = '<p style="color:red">Unstream widget: missing data-artist attribute</p>';
      return;
    }

    var shadow = container.attachShadow({ mode: 'open' });

    var isDark = theme === 'dark';
    var bg = isDark ? '#1a1a1a' : '#ffffff';
    var bgHover = isDark ? '#222222' : '#f5f5f5';
    var text = isDark ? '#f0f0f0' : '#1a1a1a';
    var textMuted = isDark ? '#999999' : '#666666';
    var border = isDark ? '#2a2a2a' : '#e0e0e0';
    var badgeBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    var badgeBgHover = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)';

    var style = document.createElement('style');
    style.textContent = [
      '@import url("https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600&display=swap");',
      '.uw-root { font-family: "Golos Text", system-ui, sans-serif; background: ' + bg + '; border: 1px solid ' + border + '; border-radius: 12px; padding: 16px; max-width: 380px; box-sizing: border-box; }',
      '.uw-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; text-decoration: none; color: inherit; }',
      '.uw-img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: ' + border + '; flex-shrink: 0; }',
      '.uw-name { font-size: 16px; font-weight: 600; color: ' + text + '; margin: 0; line-height: 1.3; }',
      '.uw-subtitle { font-size: 12px; color: ' + textMuted + '; margin: 2px 0 0; }',
      '.uw-links { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }',
      '.uw-link { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; background: ' + badgeBg + '; color: ' + text + '; text-decoration: none; font-size: 13px; font-weight: 500; transition: background 0.15s; }',
      '.uw-link:hover { background: ' + badgeBgHover + '; }',
      '.uw-link-icon { font-size: 14px; }',
      '.uw-footer { display: flex; align-items: center; justify-content: space-between; }',
      '.uw-powered { font-size: 11px; color: ' + textMuted + '; text-decoration: none; transition: color 0.15s; }',
      '.uw-powered:hover { color: #ff6b35; }',
      '.uw-more { font-size: 12px; color: #ff6b35; text-decoration: none; font-weight: 500; transition: opacity 0.15s; }',
      '.uw-more:hover { opacity: 0.8; }',
      '.uw-loading { text-align: center; padding: 20px 0; color: ' + textMuted + '; font-size: 13px; }',
      '.uw-error { text-align: center; padding: 12px 0; color: ' + textMuted + '; font-size: 13px; }',
    ].join('\n');
    shadow.appendChild(style);

    var root = document.createElement('div');
    root.className = 'uw-root';
    root.innerHTML = '<div class="uw-loading">Loading...</div>';
    shadow.appendChild(root);

    var slug = artist.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var dataUrl = BASE_URL + '/data/artists/' + slug + '.json';

    var mbUrl = BASE_URL + '/api/search/musicbrainz?query=' + encodeURIComponent(artist);

    fetch(dataUrl)
      .then(function (res) {
        if (!res.ok) throw new Error('Not found');
        var contentType = res.headers.get('content-type') || '';
        if (contentType.indexOf('application/json') === -1) throw new Error('Not JSON');
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.length) throw new Error('Empty');
        var artistData = data[0];
        var directCount = artistData.platforms.filter(isDirectLink).length;

        // If pre-generated data has enough links, render immediately
        // but still try to enrich in background
        if (directCount >= maxLinks) {
          renderWidget(root, artistData, maxLinks, slug);
          return;
        }

        // Not enough direct links — enrich with MusicBrainz before rendering
        fetch(mbUrl)
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (mbData) {
            if (mbData && mbData.artistName) {
              artistData = enrichWithMusicBrainz(artistData, mbData);
            }
            renderWidget(root, artistData, maxLinks, slug);
          })
          .catch(function () {
            // MusicBrainz failed, render with what we have
            renderWidget(root, artistData, maxLinks, slug);
          });
      })
      .catch(function () {
        // No pre-generated data — try search API + MusicBrainz enrichment
        var searchUrl = BASE_URL + '/api/search/sources?query=' + encodeURIComponent(artist);

        Promise.all([
          fetch(searchUrl).then(function (res) { return res.json(); }),
          fetch(mbUrl).then(function (res) { return res.ok ? res.json() : null; }).catch(function () { return null; }),
        ])
          .then(function (responses) {
            var data = responses[0];
            var mbData = responses[1];

            if (!data.results || data.results.length === 0) {
              root.innerHTML = '<div class="uw-error">Artist not found. <a class="uw-more" href="' + BASE_URL + '/?q=' + encodeURIComponent(artist) + '" target="_blank" rel="noopener">Search on Unstream</a></div>';
              return;
            }

            var artistResult = data.results.find(function (r) { return r.type === 'artist'; }) || data.results[0];

            // Merge MusicBrainz enrichment data if available
            if (mbData && mbData.artistName) {
              artistResult = enrichWithMusicBrainz(artistResult, mbData);
            }

            renderWidget(root, artistResult, maxLinks, slug);
          })
          .catch(function () {
            root.innerHTML = '<div class="uw-error">Could not load artist data.</div>';
          });
      });
  }

  // Merge MusicBrainz enrichment data into an artist result
  function enrichWithMusicBrainz(artist, mbData) {
    var newPlatforms = artist.platforms.slice();
    var existing = {};
    newPlatforms.forEach(function (p) { existing[p.sourceId] = true; });

    // Add official site
    if (mbData.officialUrl && !existing['officialsite']) {
      newPlatforms.push({ sourceId: 'officialsite', url: mbData.officialUrl });
      existing['officialsite'] = true;
    }

    // Add Discogs
    if (mbData.discogsUrl && !existing['discogs']) {
      newPlatforms.push({ sourceId: 'discogs', url: mbData.discogsUrl });
      existing['discogs'] = true;
    }

    // Add library services for pre-2005 artists
    if (mbData.hasPre2005Release) {
      if (!existing['hoopla']) {
        newPlatforms.push({ sourceId: 'hoopla', url: 'https://www.hoopladigital.com/search?q=' + encodeURIComponent(artist.name) + '&type=music' });
        existing['hoopla'] = true;
      }
      if (!existing['freegal']) {
        newPlatforms.push({ sourceId: 'freegal', url: 'https://www.freegalmusic.com/search-page/' + encodeURIComponent(artist.name) });
        existing['freegal'] = true;
      }
    }

    // Add social links and discovered platforms
    var socialLinks = (mbData.socialLinks || []).concat(mbData.discoveredPlatforms || []);
    socialLinks.forEach(function (link) {
      var id = link.platform;
      if (!existing[id]) {
        newPlatforms.push({ sourceId: id, url: link.url });
        existing[id] = true;
      } else {
        // Replace search-only URLs with direct links
        for (var i = 0; i < newPlatforms.length; i++) {
          if (newPlatforms[i].sourceId === id) {
            var url = newPlatforms[i].url.toLowerCase();
            if (url.indexOf('duckduckgo.com') !== -1 || url.indexOf('/search') !== -1 || url.indexOf('?q=') !== -1 || url.indexOf('explore-creators') !== -1) {
              newPlatforms[i] = { sourceId: id, url: link.url };
            }
            break;
          }
        }
      }
    });

    return { name: artist.name, type: artist.type, imageUrl: artist.imageUrl, platforms: newPlatforms, matchConfidence: artist.matchConfidence };
  }

  function renderWidget(root, artist, maxLinks, slug) {
    var directLinks = artist.platforms.filter(isDirectLink);
    var sorted = sortPlatforms(directLinks);
    var shown = sorted.slice(0, maxLinks);
    var artistUrl = BASE_URL + '/artist/' + slug;

    var html = '';

    // Header with image + name
    html += '<a class="uw-header" href="' + artistUrl + '" target="_blank" rel="noopener">';
    if (artist.imageUrl) {
      html += '<img class="uw-img" src="' + artist.imageUrl + '" alt="' + escapeHtml(artist.name) + '" />';
    }
    html += '<div>';
    html += '<p class="uw-name">' + escapeHtml(artist.name) + '</p>';
    html += '<p class="uw-subtitle">Support me directly at:</p>';
    html += '</div></a>';

    // Platform links
    html += '<div class="uw-links">';
    shown.forEach(function (link) {
      var p = platforms[link.sourceId];
      if (!p) return;
      html += '<a class="uw-link" href="' + link.url + '" target="_blank" rel="noopener">';
      html += '<span class="uw-link-icon">' + p.icon + '</span>';
      html += p.name;
      html += '</a>';
    });
    html += '</div>';

    // Footer
    html += '<div class="uw-footer">';
    html += '<a class="uw-powered" href="' + BASE_URL + '" target="_blank" rel="noopener">Powered by Unstream</a>';
    if (sorted.length > maxLinks) {
      html += '<a class="uw-more" href="' + artistUrl + '" target="_blank" rel="noopener">+' + (sorted.length - maxLinks) + ' more</a>';
    }
    html += '</div>';

    root.innerHTML = html;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // Initialize all widgets on the page
  function init() {
    var widgets = document.querySelectorAll('.unstream-widget');
    for (var i = 0; i < widgets.length; i++) {
      if (!widgets[i]._unstreamInit) {
        widgets[i]._unstreamInit = true;
        createWidget(widgets[i]);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
