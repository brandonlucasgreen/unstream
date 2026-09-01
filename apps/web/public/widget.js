(function () {
  'use strict';

  var scriptEl = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var BASE_URL = 'https://unstream.stream';
  if (scriptEl && scriptEl.src) {
    try {
      var scriptUrl = new URL(scriptEl.src);
      BASE_URL = scriptUrl.origin;
    } catch (e) { /* fall back to default */ }
  }

  var platforms = {
    bandcamp: { name: 'Bandcamp', color: '#1da0c3', icon: '\uD83C\uDFB5' },
    mirlo: { name: 'Mirlo', color: '#6366f1', icon: '\uD83E\uDEBA' },
    ampwall: { name: 'Ampwall', color: '#ef4444', icon: '\uD83D\uDD0A' },
    bandwagon: { name: 'Bandwagon', color: '#8b5cf6', icon: '\uD83D\uDE90' },
    faircamp: { name: 'Faircamp', color: '#22c55e', icon: '\uD83C\uDFD5\uFE0F' },
    qobuz: { name: 'Qobuz', color: '#0170eb', icon: '\uD83C\uDFA7' },
    patreon: { name: 'Patreon', color: '#ff424d', icon: '\uD83C\uDFA8' },
    kofi: { name: 'Ko-fi', color: '#13c3ff', icon: '\uD83C\uDF75' },
    buymeacoffee: { name: 'Buy Me a Coffee', color: '#ffdd00', icon: '\u2615' },
    officialsite: { name: 'Official Site', color: '#f59e0b', icon: '\uD83C\uDF10' },
    discogs: { name: 'Discogs', color: '#333333', icon: '\uD83D\uDCC0' },
    musicbrainz: { name: 'MusicBrainz', color: '#eb743b', icon: '\uD83E\uDDE0' },
    internetarchive: { name: 'Internet Archive', color: '#428bca', icon: '\uD83C\uDFDB\uFE0F' },
    funkwhale: { name: 'Funkwhale', color: '#0084c7', icon: '\uD83D\uDC0B' },
    librefm: { name: 'Libre.fm', color: '#a40000', icon: '\uD83D\uDCFB' },
    listenbrainz: { name: 'ListenBrainz', color: '#353070', icon: '\uD83D\uDC42' },
    instagram: { name: 'Instagram', color: '#E4405F', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#E4405F"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>' },
    facebook: { name: 'Facebook', color: '#1877F2', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>' },
    tiktok: { name: 'TikTok', color: '#000000', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>' },
    youtube: { name: 'YouTube', color: '#FF0000', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>' },
    threads: { name: 'Threads', color: '#000000', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>' },
    bluesky: { name: 'Bluesky', color: '#0085ff', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#0085FF"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z"/></svg>' },
    mastodon: { name: 'Mastodon', color: '#6364FF', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#858AFA"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>' },
    peertube: { name: 'PeerTube', color: '#F1680D', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#F1680D"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-1.243 17.07V6.93L18.258 12l-7.5 5.07z"/></svg>' },
    hoopla: { name: 'Hoopla', color: '#e86c2e', icon: '\uD83D\uDCDA' },
    freegal: { name: 'Freegal', color: '#4caf50', icon: '\uD83C\uDFB6' },
    jamcoop: { name: 'Jam.coop', color: '#e91e63', icon: '\uD83C\uDFB8' },
  };

  var priorityCategories = [
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

  function isDirectLink(link) {
    var url = link.url || '';
    return (
      url.indexOf('duckduckgo.com') === -1 &&
      url.indexOf('google.com/search') === -1 &&
      url.indexOf('searchStyle=search') === -1 &&
      url.indexOf('explore-creators') === -1
    );
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
    var text = isDark ? '#f0f0f0' : '#1a1a1a';
    var textMuted = isDark ? '#999999' : '#666666';
    var border = isDark ? '#2a2a2a' : '#e0e0e0';
    var badgeBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    var badgeBgHover = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)';

    var style = document.createElement('style');
    style.textContent = [
      '@import url("https://api.fonts.coollabs.io/css2?family=Stack+Sans+Headline:wght@400;500;600&display=swap");',
      '.uw-root { font-family: "Stack Sans Headline", system-ui, sans-serif; background: ' + bg + '; border: 1px solid ' + border + '; border-radius: 12px; padding: 16px; max-width: 380px; box-sizing: border-box; }',
      '.uw-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; text-decoration: none; color: inherit; }',
      '.uw-img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: ' + border + '; flex-shrink: 0; }',
      '.uw-name { font-size: 16px; font-weight: 600; color: ' + text + '; margin: 0; line-height: 1.3; }',
      '.uw-subtitle { font-size: 12px; color: ' + textMuted + '; margin: 2px 0 0; }',
      '.uw-links { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }',
      '.uw-link { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; background: ' + badgeBg + '; color: ' + text + '; text-decoration: none; font-size: 13px; font-weight: 500; transition: background 0.15s; }',
      '.uw-link:hover { background: ' + badgeBgHover + '; }',
      '.uw-link-icon { font-size: 14px; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; }',
      '.uw-link-icon svg { width: 14px; height: 14px; flex-shrink: 0; }',
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

    // Try the artist API first (fast for DB artists), fall back to search
    var artistUrl = BASE_URL + '/api/artist?slug=' + encodeURIComponent(slug);
    fetch(artistUrl)
      .then(function (res) {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.name) throw new Error('Invalid');
        renderWidget(root, data, maxLinks, slug);
      })
      .catch(function () {
        // Fall back to search API
        var searchUrl = BASE_URL + '/api/search/sources?query=' + encodeURIComponent(artist);
        fetch(searchUrl)
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (!data.results || data.results.length === 0) {
              root.innerHTML = '<div class="uw-error">Artist not found. <a class="uw-more" href="' + BASE_URL + '/?q=' + encodeURIComponent(artist) + '" target="_blank" rel="noopener">Search on Unstream</a></div>';
              return;
            }
            var artistResult = data.results.find(function (r) { return r.type === 'artist'; }) || data.results[0];
            renderWidget(root, artistResult, maxLinks, slug);
          })
          .catch(function () {
            root.innerHTML = '<div class="uw-error">Could not load artist data.</div>';
          });
      });
  }

  function renderWidget(root, artist, maxLinks, slug) {
    var directLinks = (artist.platforms || []).filter(isDirectLink);
    var sorted = sortPlatforms(directLinks);
    var shown = sorted.slice(0, maxLinks);
    var profileUrl = BASE_URL + '/a/' + slug;

    var html = '';

    html += '<a class="uw-header" href="' + profileUrl + '" target="_blank" rel="noopener">';
    if (artist.imageUrl) {
      html += '<img class="uw-img" src="' + escapeHtml(artist.imageUrl) + '" alt="' + escapeHtml(artist.name) + '" />';
    }
    html += '<div>';
    html += '<p class="uw-name">' + escapeHtml(artist.name) + '</p>';
    html += '<p class="uw-subtitle">Support me directly at:</p>';
    html += '</div></a>';

    html += '<div class="uw-links">';
    shown.forEach(function (link) {
      var p = platforms[link.sourceId];
      if (!p) return;
      html += '<a class="uw-link" href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener">';
      html += '<span class="uw-link-icon">' + p.icon + '</span>';
      html += escapeHtml(p.name);
      html += '</a>';
    });
    html += '</div>';

    html += '<div class="uw-footer">';
    html += '<a class="uw-powered" href="' + BASE_URL + '" target="_blank" rel="noopener">Powered by Unstream</a>';
    if (sorted.length > maxLinks) {
      html += '<a class="uw-more" href="' + profileUrl + '" target="_blank" rel="noopener">+' + (sorted.length - maxLinks) + ' more</a>';
    }
    html += '</div>';

    root.innerHTML = html;
  }

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
