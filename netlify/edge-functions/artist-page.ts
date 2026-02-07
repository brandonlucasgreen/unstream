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

// Platform display names and colors for static rendering
const PLATFORM_INFO: Record<string, { name: string; color: string; icon: string; category: string; searchOnly?: boolean; payoutPercent?: string }> = {
  bandcamp: { name: 'Bandcamp', color: '#1da0c3', icon: '🎵', category: 'marketplace', payoutPercent: '80-85%' },
  mirlo: { name: 'Mirlo', color: '#6366f1', icon: '🪺', category: 'marketplace', payoutPercent: '86-90%' },
  ampwall: { name: 'Ampwall', color: '#ef4444', icon: '🔊', category: 'marketplace', searchOnly: true, payoutPercent: '92-95%' },
  bandwagon: { name: 'Bandwagon', color: '#8b5cf6', icon: '🚐', category: 'decentralized' },
  faircamp: { name: 'Faircamp', color: '#22c55e', icon: '🏕️', category: 'decentralized', payoutPercent: '90-97%' },
  patreon: { name: 'Patreon', color: '#ff424d', icon: '🎨', category: 'patronage', payoutPercent: '86-90%' },
  buymeacoffee: { name: 'Buy Me a Coffee', color: '#ffdd00', icon: '☕', category: 'patronage', searchOnly: true, payoutPercent: '~92%' },
  kofi: { name: 'Ko-fi', color: '#29abe0', icon: '🍵', category: 'patronage', searchOnly: true, payoutPercent: '92-97%' },
  hoopla: { name: 'Hoopla', color: '#9333ea', icon: '🎧', category: 'library' },
  freegal: { name: 'Freegal', color: '#e91e63', icon: '🎵', category: 'library' },
  qobuz: { name: 'Qobuz', color: '#0070f3', icon: '💿', category: 'marketplace', payoutPercent: '~70%' },
  jamcoop: { name: 'Jam.coop', color: '#e11d48', icon: '🎸', category: 'marketplace' },
  officialsite: { name: 'Official Site', color: '#71717a', icon: '🌐', category: 'official' },
  discogs: { name: 'Discogs', color: '#333333', icon: '💿', category: 'marketplace' },
  instagram: { name: 'Instagram', color: '#E4405F', icon: 'social', category: 'social' },
  facebook: { name: 'Facebook', color: '#1877F2', icon: 'social', category: 'social' },
  tiktok: { name: 'TikTok', color: '#E0E0E0', icon: 'social', category: 'social' },
  youtube: { name: 'YouTube', color: '#FF0000', icon: 'social', category: 'social' },
  threads: { name: 'Threads', color: '#E0E0E0', icon: 'social', category: 'social' },
  bluesky: { name: 'Bluesky', color: '#0085FF', icon: 'social', category: 'social' },
  mastodon: { name: 'Mastodon', color: '#6364FF', icon: 'social', category: 'social' },
};

const CATEGORY_ORDER = ['marketplace', 'patronage', 'library', 'decentralized', 'official'];
const CATEGORY_NAMES: Record<string, string> = {
  marketplace: 'Music Marketplaces',
  patronage: 'Patronage Platforms',
  library: 'Library Services',
  decentralized: 'Decentralized',
  official: 'Official',
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderPlatformBadge(platform: PlatformLink): string {
  const info = PLATFORM_INFO[platform.sourceId];
  if (!info) return '';

  // Social platforms render as icon-only circles (handled separately)
  if (info.category === 'social') return '';

  const isSearchOnly = info.searchOnly;
  const label = isSearchOnly ? `Search ${info.name}` : info.name;

  return `<a href="${escapeHtml(platform.url)}" target="_blank" rel="noopener noreferrer"
    class="source-badge" style="background-color: ${info.color}15; color: ${info.color}; border: 1px solid ${info.color}30;"
    ${info.payoutPercent ? `title="Artist payout: ${info.payoutPercent}"` : ''}>
    <span>${info.icon}</span>
    <span>${escapeHtml(label)}</span>
  </a>`;
}

function renderSocialLink(platform: PlatformLink): string {
  const info = PLATFORM_INFO[platform.sourceId];
  if (!info || info.category !== 'social') return '';

  return `<a href="${escapeHtml(platform.url)}" target="_blank" rel="noopener noreferrer"
    title="${escapeHtml(info.name)}"
    style="display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: ${info.color}15; border: 1px solid ${info.color}30; color: ${info.color}; text-decoration: none;">
    <span style="font-size: 14px; font-weight: 600;">${escapeHtml(info.name.charAt(0))}</span>
  </a>`;
}

function renderResultCard(result: SearchResult): string {
  const nonSocialPlatforms = result.platforms.filter(p => {
    const info = PLATFORM_INFO[p.sourceId];
    return info && info.category !== 'social';
  });
  const socialPlatforms = result.platforms.filter(p => {
    const info = PLATFORM_INFO[p.sourceId];
    return info && info.category === 'social';
  });

  // Group non-social platforms by category
  const grouped: Record<string, PlatformLink[]> = {};
  for (const p of nonSocialPlatforms) {
    const cat = PLATFORM_INFO[p.sourceId]?.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  }

  let platformsHtml = '';
  for (const cat of CATEGORY_ORDER) {
    if (!grouped[cat] || grouped[cat].length === 0) continue;
    platformsHtml += `<div style="margin-bottom: 12px;">
      <p style="color: #999; font-size: 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(CATEGORY_NAMES[cat] || cat)}</p>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        ${grouped[cat].map(p => renderPlatformBadge(p)).join('')}
      </div>
    </div>`;
  }

  if (socialPlatforms.length > 0) {
    platformsHtml += `<div style="margin-bottom: 12px;">
      <p style="color: #999; font-size: 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">Social</p>
      <div style="display: flex; flex-wrap: wrap; gap: 8px;">
        ${socialPlatforms.map(p => renderSocialLink(p)).join('')}
      </div>
    </div>`;
  }

  const typeBadge = result.type === 'artist'
    ? '<span style="background: #ff6b3520; color: #ff6b35; padding: 2px 8px; border-radius: 6px; font-size: 12px;">Artist</span>'
    : result.type === 'album'
    ? '<span style="background: #4ecdc420; color: #4ecdc4; padding: 2px 8px; border-radius: 6px; font-size: 12px;">Album</span>'
    : '<span style="background: #ffe66d20; color: #ffe66d; padding: 2px 8px; border-radius: 6px; font-size: 12px;">Track</span>';

  const imageHtml = result.imageUrl
    ? `<img src="${escapeHtml(result.imageUrl)}" alt="${escapeHtml(result.name)}" style="width: 64px; height: 64px; border-radius: 12px; object-fit: cover; flex-shrink: 0;" />`
    : `<div style="width: 64px; height: 64px; border-radius: 12px; background: #222; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 24px;">🎵</div>`;

  return `<div class="result-card" style="background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 20px; margin-bottom: 16px;">
    <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 16px;">
      ${imageHtml}
      <div>
        <h2 style="color: #f0f0f0; font-size: 20px; font-weight: 600; margin: 0 0 4px 0;">${escapeHtml(result.name)}</h2>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${typeBadge}
          <span style="color: #666; font-size: 13px;">${result.platforms.length} platform${result.platforms.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
    ${platformsHtml}
  </div>`;
}

function renderJsonLd(artistName: string, results: SearchResult[], slug: string): string {
  const firstArtist = results.find(r => r.type === 'artist');
  const sameAs = firstArtist?.platforms
    .filter(p => !PLATFORM_INFO[p.sourceId]?.searchOnly)
    .map(p => p.url) || [];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicGroup',
    name: artistName,
    url: `https://unstream.stream/artist/${slug}`,
    ...(firstArtist?.imageUrl ? { image: firstArtist.imageUrl } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
  };

  return `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
}

function generateArtistPageHtml(
  artistName: string,
  slug: string,
  results: SearchResult[],
  cssHref: string,
  jsHref: string,
): string {
  const title = `${artistName} on Unstream - Find music on alternative platforms`;
  const description = `Find ${artistName} on Bandcamp, Qobuz, and other ethical music platforms. Support artists directly.`;
  const firstArtist = results.find(r => r.type === 'artist');
  const ogImage = firstArtist?.imageUrl || 'https://unstream.stream/og-image.png';
  const canonicalUrl = `https://unstream.stream/artist/${slug}`;

  const resultsHtml = results.map(r => renderResultCard(r)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">

  <!-- Canonical -->
  <link rel="canonical" href="${canonicalUrl}">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:url" content="${canonicalUrl}">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">

  ${renderJsonLd(artistName, results, slug)}

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap" rel="stylesheet">

  <!-- App CSS -->
  ${cssHref ? `<link rel="stylesheet" href="${cssHref}">` : ''}

  <style>
    body { background: #0d0d0d; color: #f0f0f0; font-family: 'Golos Text', system-ui, sans-serif; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
    .source-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; font-size: 14px; text-decoration: none; transition: transform 0.15s, box-shadow 0.15s; }
    .source-badge:hover { transform: scale(1.05); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  </style>
</head>
<body>
  <div id="root">
    <!-- Static pre-rendered content for SEO crawlers -->
    <div style="min-height: 100vh;">
      <!-- Header -->
      <header style="padding: 32px 16px;">
        <div style="max-width: 896px; margin: 0 auto; text-align: center;">
          <h1 style="font-size: 2.5rem; font-weight: 700; margin-bottom: 16px;">
            <a href="/" style="color: #f0f0f0; text-decoration: none;">Unstream 🤘🏻</a>
          </h1>
          <p style="color: #999; font-size: 1.125rem; max-width: 640px; margin: 0 auto;">
            Find your favorite music on alternative platforms, directly support the artists you love, and move off streaming.
          </p>
        </div>
      </header>

      <!-- Results -->
      <main style="padding: 0 16px 64px;">
        <div style="max-width: 896px; margin: 0 auto;">
          <p style="color: #666; font-size: 14px; margin-bottom: 16px;">
            Found ${results.length} result${results.length !== 1 ? 's' : ''} for <strong style="color: #f0f0f0;">${escapeHtml(artistName)}</strong>
          </p>
          ${resultsHtml}
        </div>
      </main>

      <!-- Footer -->
      <footer style="border-top: 1px solid #2a2a2a; padding: 24px 16px; text-align: center;">
        <div style="max-width: 896px; margin: 0 auto; color: #999; font-size: 14px;">
          <span>Made with love in Massachusetts, USA</span>
          <nav style="margin-top: 12px; display: flex; flex-wrap: wrap; justify-content: center; gap: 12px;">
            <a href="https://unstream.featurebase.app/roadmap" style="color: #999; text-decoration: none;">Roadmap</a>
            <a href="mailto:support@unstream.stream" style="color: #999; text-decoration: none;">Support</a>
            <a href="https://unstream.goatcounter.com" style="color: #999; text-decoration: none;">Metrics</a>
            <a href="https://liberapay.com/brandonlucasgreen/donate" style="color: #999; text-decoration: none;">Donate</a>
            <a href="/privacy-policy" style="color: #999; text-decoration: none;">Privacy</a>
          </nav>
        </div>
      </footer>
    </div>
  </div>

  <!-- Load React app for interactivity -->
  ${jsHref ? `<script type="module" src="${jsHref}"></script>` : '<script type="module" src="/src/main.tsx"></script>'}

  <!-- Analytics -->
  <script data-goatcounter="https://unstream.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
</body>
</html>`;
}

async function findBuiltAssets(origin: string): Promise<{ cssHref: string; jsHref: string }> {
  // Try to fetch the normal index.html to extract built asset paths
  try {
    const res = await fetch(`${origin}/index.html`);
    if (res.ok) {
      const html = await res.text();

      // Extract CSS link
      const cssMatch = html.match(/<link[^>]+href="(\/assets\/[^"]+\.css)"/);
      const cssHref = cssMatch?.[1] || '';

      // Extract JS module script
      const jsMatch = html.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"[^>]*type="module"/);
      const jsHref = jsMatch?.[1] || '';

      return { cssHref, jsHref };
    }
  } catch {
    // Fall through
  }

  return { cssHref: '', jsHref: '' };
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  const pathMatch = url.pathname.match(/^\/artist\/([a-z0-9-]+)\/?$/);

  if (!pathMatch) {
    return context.next();
  }

  const slug = pathMatch[1];
  const origin = `${url.protocol}//${url.host}`;

  // Fetch pre-generated artist data
  let results: SearchResult[];
  let artistName: string;

  try {
    const dataUrl = `${origin}/data/artists/${slug}.json`;
    const dataRes = await fetch(dataUrl);

    if (!dataRes.ok) {
      // No pre-generated data, fall through to SPA
      return context.next();
    }

    results = await dataRes.json();

    // Derive artist name from first artist result, or from slug
    const firstArtist = results.find(r => r.type === 'artist');
    artistName = firstArtist?.name || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return context.next();
  }

  if (!results || results.length === 0) {
    return context.next();
  }

  // Find built CSS/JS assets
  const { cssHref, jsHref } = await findBuiltAssets(origin);

  const html = generateArtistPageHtml(artistName, slug, results, cssHref, jsHref);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
    },
  });
}

export const config = {
  path: "/artist/*",
};
