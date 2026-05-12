import { Context } from "https://edge.netlify.com";

interface PlatformLink {
  sourceId: string;
  url: string;
  latestRelease?: {
    title: string;
    type: string;
    url: string;
    imageUrl?: string;
    releaseDate?: string;
  };
}

interface SearchResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: PlatformLink[];
  matchConfidence?: 'verified' | 'unverified';
}

const PLATFORM_INFO: Record<string, { name: string; icon: string; category: string; searchOnly?: boolean; payoutPercent?: string }> = {
  bandcamp: { name: 'Bandcamp', icon: '🎵', category: 'marketplace', payoutPercent: '80-85%' },
  mirlo: { name: 'Mirlo', icon: '🪺', category: 'marketplace', payoutPercent: '86-90%' },
  ampwall: { name: 'Ampwall', icon: '🔊', category: 'marketplace', searchOnly: true, payoutPercent: '92-95%' },
  subvert: { name: 'Subvert', icon: '✊', category: 'marketplace', searchOnly: true, payoutPercent: '~100%' },
  bandwagon: { name: 'Bandwagon', icon: '🚐', category: 'decentralized' },
  faircamp: { name: 'Faircamp', icon: '🏕️', category: 'decentralized', payoutPercent: '90-97%' },
  patreon: { name: 'Patreon', icon: '🎨', category: 'patronage', payoutPercent: '86-90%' },
  buymeacoffee: { name: 'Buy Me a Coffee', icon: '☕', category: 'patronage', searchOnly: true, payoutPercent: '~92%' },
  kofi: { name: 'Ko-fi', icon: '🍵', category: 'patronage', searchOnly: true, payoutPercent: '92-97%' },
  hoopla: { name: 'Hoopla', icon: '🎧', category: 'library' },
  freegal: { name: 'Freegal', icon: '🎵', category: 'library' },
  qobuz: { name: 'Qobuz', icon: '💿', category: 'marketplace', payoutPercent: '~70%' },
  jamcoop: { name: 'Jam.coop', icon: '🎸', category: 'marketplace' },
  officialsite: { name: 'Official Site', icon: '🌐', category: 'official' },
  discogs: { name: 'Discogs', icon: '💿', category: 'marketplace' },
  instagram: { name: 'Instagram', icon: '📷', category: 'social' },
  facebook: { name: 'Facebook', icon: '👤', category: 'social' },
  tiktok: { name: 'TikTok', icon: '🎬', category: 'social' },
  youtube: { name: 'YouTube', icon: '▶️', category: 'social' },
  threads: { name: 'Threads', icon: '🧵', category: 'social' },
  bluesky: { name: 'Bluesky', icon: '🦋', category: 'social' },
  mastodon: { name: 'Mastodon', icon: '🐘', category: 'social' },
  peertube: { name: 'PeerTube', icon: '🎥', category: 'social' },
};

const CATEGORY_ORDER = ['marketplace', 'patronage', 'library', 'decentralized', 'official'];
const CATEGORY_LABELS: Record<string, string> = {
  marketplace: 'Support directly',
  patronage: 'Patronage',
  library: 'Libraries',
  decentralized: 'Decentralized',
  official: 'Official',
  social: 'Social',
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderResultCard(result: SearchResult): string {
  const name = escapeHtml(result.name);
  const platforms = result.platforms.filter(p => {
    const u = p.url.toLowerCase();
    return !u.includes('duckduckgo.com') && !u.includes('google.com/search') && !u.includes('searchstyle=search');
  });

  const mainPlatforms = platforms.filter(p => PLATFORM_INFO[p.sourceId]?.category !== 'social');
  const socialPlatforms = platforms.filter(p => PLATFORM_INFO[p.sourceId]?.category === 'social');

  // Group by category
  const grouped: Record<string, PlatformLink[]> = {};
  for (const p of mainPlatforms) {
    const cat = PLATFORM_INFO[p.sourceId]?.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  }

  let platformsHtml = '';
  for (const cat of CATEGORY_ORDER) {
    if (!grouped[cat] || grouped[cat].length === 0) continue;
    const links = grouped[cat].map(p => {
      const info = PLATFORM_INFO[p.sourceId];
      if (!info) return '';
      const label = info.searchOnly ? `Search ${info.name}` : info.name;
      return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" class="platform-link">
        <span class="platform-icon">${info.icon}</span>
        <span class="platform-name">${escapeHtml(label)}</span>
        ${info.payoutPercent ? `<span class="payout">${info.payoutPercent} to artist</span>` : ''}
        <span class="external-icon">↗</span>
      </a>`;
    }).join('');

    platformsHtml += `
      <div class="category-label">${CATEGORY_LABELS[cat] || cat}</div>
      <div class="platform-list">${links}</div>`;
  }

  // Social links
  if (socialPlatforms.length > 0) {
    const socialLinks = socialPlatforms.map(p => {
      const info = PLATFORM_INFO[p.sourceId];
      if (!info) return '';
      return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(info.name)}" class="social-link">${info.icon}</a>`;
    }).join('');
    platformsHtml += `
      <div class="category-label" style="margin-top:16px">Social</div>
      <div class="social-list">${socialLinks}</div>`;
  }

  const badge = result.matchConfidence === 'verified'
    ? '<span class="badge verified">Verified</span>'
    : '';

  return `<div class="result-card">
    <div class="result-header">
      ${result.imageUrl ? `<img src="${escapeHtml(result.imageUrl)}" alt="${name}" class="result-image" loading="lazy">` : ''}
      <div>
        <h2 class="result-name">${name} ${badge}</h2>
        <span class="result-type">${result.type}</span>
      </div>
    </div>
    ${platformsHtml}
  </div>`;
}

function renderPage(query: string, results: SearchResult[], error?: string): string {
  const escapedQuery = escapeHtml(query);

  let bodyContent = '';
  if (error) {
    bodyContent = `<p class="error-msg">${escapeHtml(error)}</p>`;
  } else if (query && results.length === 0) {
    bodyContent = `<p class="no-results">No results found for "${escapedQuery}". Try a different spelling or search for another artist.</p>`;
  } else if (results.length > 0) {
    // Only show artist-type results in noscript mode for clarity
    const artistResults = results.filter(r => r.type === 'artist');
    const displayResults = artistResults.length > 0 ? artistResults : results.slice(0, 5);
    bodyContent = displayResults.map(renderResultCard).join('');
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${query ? `${escapedQuery} - Unstream Search` : 'Search - Unstream'}</title>
  <meta name="description" content="Search any artist. See where your money actually goes. Unstream shows artist payout percentages across 17 platforms.">
  <meta name="robots" content="noindex">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #0d0d0d; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; --footer-border: #1a1a1a; }
    @media (prefers-color-scheme: light) {
      :root { --bg: #ffffff; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; --footer-border: #e0e0e0; }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Golos Text', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    .container { max-width: 640px; margin: 0 auto; padding: 0 24px; width: 100%; }

    /* Header */
    .header { padding: 32px 0 24px; text-align: center; }
    .header h1 { font-size: 24px; font-weight: 700; }
    .header h1 a { text-decoration: none; color: var(--text); }
    .header p { font-size: 14px; color: var(--muted); margin-top: 4px; }

    /* Search form */
    .search-form { display: flex; gap: 8px; margin-bottom: 32px; }
    .search-input {
      flex: 1; padding: 12px 16px; border-radius: 12px;
      border: 1px solid var(--border); background: var(--bg2);
      color: var(--text); font-size: 16px; font-family: inherit;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent); }
    .search-input::placeholder { color: var(--muted); }
    .search-btn {
      padding: 12px 24px; border-radius: 12px; border: none;
      background: var(--accent); color: #fff; font-size: 16px;
      font-family: inherit; font-weight: 600; cursor: pointer;
    }
    .search-btn:hover { opacity: 0.9; }

    /* Results */
    .result-card {
      border: 1px solid var(--border); border-radius: 16px;
      padding: 24px; margin-bottom: 20px; background: var(--bg2);
    }
    .result-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
    .result-image { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border); }
    .result-name { font-size: 20px; font-weight: 700; }
    .result-type { font-size: 12px; color: var(--muted); text-transform: capitalize; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; vertical-align: middle; }
    .badge.verified { background: #22c55e20; color: #22c55e; }

    .category-label {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--muted); margin-bottom: 8px; margin-top: 16px;
    }
    .category-label:first-child { margin-top: 0; }
    .platform-list { display: grid; gap: 8px; }
    .platform-link {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px; border-radius: 10px;
      background: var(--bg); border: 1px solid var(--border);
      text-decoration: none; color: var(--text); font-size: 14px;
    }
    .platform-link:hover { border-color: var(--accent); }
    .platform-icon { font-size: 18px; }
    .platform-name { flex: 1; font-weight: 500; }
    .payout { font-size: 11px; color: var(--muted); }
    .external-icon { color: var(--muted); font-size: 14px; }

    .social-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .social-link {
      display: inline-flex; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: 50%;
      background: var(--bg); border: 1px solid var(--border);
      text-decoration: none; font-size: 18px;
    }
    .social-link:hover { border-color: var(--accent); }

    .no-results, .error-msg { color: var(--muted); font-size: 16px; text-align: center; padding: 48px 0; }
    .error-msg { color: #ef4444; }
    .noscript-note { font-size: 13px; color: var(--muted); text-align: center; margin-bottom: 24px; }

    /* Footer */
    footer { margin-top: auto; padding: 24px 16px; border-top: 1px solid var(--footer-border); }
    .footer-inner {
      max-width: 640px; margin: 0 auto; display: flex; flex-direction: column;
      align-items: center; gap: 12px; font-size: 14px; color: var(--muted);
    }
    .footer-inner a { color: var(--muted); text-decoration: none; }
    .footer-inner a:hover { color: var(--text); }
    .footer-nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; }
    .footer-dot { opacity: 0.4; font-size: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><a href="/search">Unstream</a></h1>
      <p>Find music on platforms that pay artists fairly.</p>
    </div>

    <form class="search-form" action="/search" method="get">
      <input type="text" name="q" class="search-input" placeholder="Search for an artist..." value="${escapedQuery}" autofocus>
      <button type="submit" class="search-btn">Search</button>
    </form>

    <p class="noscript-note">You're viewing Unstream without JavaScript. Some features are unavailable, but search works fine.</p>

    ${bodyContent}
  </div>

  <footer>
    <div class="footer-inner">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer">Made with love in Massachusetts, USA</a>
      <nav class="footer-nav">
        <a href="/artists">Artist index</a>
        <span class="footer-dot">&#x2022;</span>
        <a href="https://unstream.featurebase.app/roadmap" target="_blank" rel="noopener noreferrer">Roadmap</a>
        <span class="footer-dot">&#x2022;</span>
        <a href="mailto:support@unstream.stream">Support</a>
        <span class="footer-dot">&#x2022;</span>
        <a href="https://liberapay.com/brandonlucasgreen/donate" target="_blank" rel="noopener noreferrer">Donate</a>
        <span class="footer-dot">&#x2022;</span>
        <a href="/privacy-policy">Privacy</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() || '';

  // No query — render empty search page
  if (!query) {
    return new Response(renderPage('', []), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Fetch search results from the internal API
  const baseUrl = `${url.protocol}//${url.host}`;
  try {
    const searchUrl = new URL('/api/search/sources', baseUrl);
    searchUrl.searchParams.set('query', query);

    const response = await fetch(searchUrl.toString(), {
      headers: { 'User-Agent': 'Unstream NoScript Search' },
    });

    if (!response.ok) {
      return new Response(renderPage(query, [], 'Search is temporarily unavailable. Please try again.'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    const data = await response.json();
    const results: SearchResult[] = data.results || [];

    return new Response(renderPage(query, results), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response(renderPage(query, [], 'Something went wrong. Please try again.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

export const config = {
  path: "/search",
};
