// Edge function: /u/{handle}
// Static HTML renderer for public saved-artists pages.
// Models after api/edge/artist-page-static.ts — same pattern, same RLS-aware data fetching.
// Real browsers get the SPA (PublicSavedArtistsPage.tsx), same as a client-side <Link>
// navigation would render, so a direct load and an in-app click produce the same UI (see
// docs/retros/UNS-100-bifurcation-retro.md). Only crawlers get this static render.

import { Context } from "https://edge.netlify.com";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isSocialCrawler, isIndexingCrawler } from "../shared/crawler-detection.ts";

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 110 110" aria-hidden="true"><defs><filter id="gs"><feColorMatrix type="saturate" values="0"/></filter></defs><g transform="translate(22,22) scale(1.8333)" filter="url(#gs)"><path fill="#50A5E6" d="M30 22c-3 0-6.688 7.094-7 10-.421 3.915 2 4 2 4h11V26s-3.438-4-6-4z"/><ellipse transform="rotate(-60 27.574 28.49)" fill="#1C6399" cx="27.574" cy="28.489" rx="5.848" ry="1.638"/><path fill="#F9CA55" d="M20.086 0c1.181 0 2.138.957 2.138 2.138 0 .789.668 10.824.668 10.824L17.948 18V2.138C17.948.957 18.905 0 20.086 0z"/><path fill="#FFDC5D" d="M18.875 4.323c0-1.099.852-1.989 1.903-1.989 1.051 0 1.903.891 1.903 1.989 0 0 .535 5.942 1.192 9.37.878 1.866 1.369 4.682 1.261 6.248.054.398 5.625 5.006 5.625 5.006-.281 1.813-2.259 6.155-4.759 8.159l-3.521-2.924c-2.885-.404-4.458-3.331-4.458-4.264 0-2.984.854-21.595.854-21.595z"/><path fill="#50A5E6" d="M6 22c3 0 6.688 7.094 7 10 .421 3.915-2 4-2 4H0V26s3.438-4 6-4z"/><ellipse transform="rotate(-30 8.424 28.489)" fill="#1C6399" cx="8.426" cy="28.489" rx="1.638" ry="5.848"/><path fill="#F9CA55" d="M16.061.011c-1.266-.127-2.333.864-2.333 2.103 0 .78-.184 10.319-.184 10.319L17.895 18l.062-15.765c0-1.106-.795-2.114-1.896-2.224z"/><path fill="#FFDC5D" d="M17.125 4.323c0-1.099-.852-1.989-1.903-1.989-1.051 0-1.903.891-1.903 1.989 0 0-.535 5.942-1.192 9.37-.878 1.866-1.369 4.682-1.261 6.248-.054.398-5.625 5.006-5.625 5.006C5.522 26.76 7.5 31.102 10 33.106l3.521-2.924c2.885-.404 4.458-3.331 4.458-4.264 0-2.984-.854-21.595-.854-21.595z"/><path fill="#F9CA55" d="M17.958 25.823c-.414 0-.75-.336-.75-.75V2.792c0-.414.336-.75.75-.75s.75.336.75.75v22.282c.001.413-.335.749-.75.749z"/></g><path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><line x1="14" y1="52" x2="14" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><line x1="96" y1="52" x2="96" y2="64" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><rect x="3" y="60" width="22" height="28" rx="9" fill="currentColor"/><rect x="85" y="60" width="22" height="28" rx="9" fill="currentColor"/></svg>';

const CSS = `
  :root { --bg: #121212; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; --footer-border: #1a1a1a; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; --footer-border: #e0e0e0; }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Stack Sans Headline', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
  h1, h2 { font-family: 'Darker Grotesque', 'Stack Sans Headline', system-ui, sans-serif; }
  a { color: inherit; }
  .container { max-width: 640px; margin: 0 auto; padding: 0 24px; width: 100%; }
  .page-content { position: relative; flex: 1; display: flex; flex-direction: column; }
  .site-header { padding: 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .site-header .brand { display: flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 700; color: var(--text); text-decoration: none; flex-shrink: 0; }
  .site-header .brand:hover { opacity: 0.8; }
  .site-header .brand svg { flex-shrink: 0; }
  .site-header .header-search { display: flex; gap: 8px; flex: 1; max-width: 420px; margin: 0 auto; }
  .site-header .header-search input { flex: 1; min-width: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 14px; color: var(--text); font-family: inherit; }
  .site-header .header-search input:focus { outline: none; border-color: var(--accent); }
  .site-header .header-search button { border: 0; border-radius: 8px; padding: 8px 14px; background: var(--accent); color: #fff; font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit; }
  @media (max-width: 640px) { .site-header .header-search { display: none; } }
  .artist-card { display: flex; align-items: center; gap: 16px; padding: 16px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg2); text-decoration: none; color: var(--text); transition: background 0.15s; }
  .artist-card:hover { background: var(--border); }
  .artist-avatar { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; flex-shrink: 0; background: var(--border); display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 600; color: var(--muted); overflow: hidden; }
  .artist-name { font-weight: 600; font-size: 16px; }
  .supported-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; background: rgba(255,107,53,0.15); color: var(--accent); }
  .copy-btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); font-size: 14px; cursor: pointer; transition: background 0.15s; }
  .copy-btn:hover { background: var(--border); }
  .copy-btn.copied { color: #22c55e; border-color: rgba(34,197,94,0.3); }
  .collection-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  @media (max-width: 640px) { .collection-grid { grid-template-columns: repeat(3, 1fr); } }
  .collection-tile { display: block; text-decoration: none; color: var(--text); min-width: 0; }
  .collection-art { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; background: var(--border); display: block; }
  .collection-art-fallback { width: 100%; aspect-ratio: 1; border-radius: 8px; background: var(--border); display: flex; align-items: center; justify-content: center; padding: 8px; font-size: 11px; color: var(--muted); text-align: center; overflow: hidden; }
  .collection-caption { margin-top: 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .collection-caption .caption-artist { color: var(--muted); }
`;

/** Tiles on the crawler render. A deliberate cap for page weight — the SPA shows everything. */
const CRAWLER_COLLECTION_LIMIT = 60;

export default async function handler(request: Request, context: Context) {
  try {
    const url = new URL(request.url);
    const handle = url.pathname.replace(/^\/u\//, '').replace(/\/$/, '');

    if (!handle) return context.next();

    const userAgent = request.headers.get('user-agent');
    if (!isSocialCrawler(userAgent) && !isIndexingCrawler(userAgent)) {
      return context.next();
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_KEY");
    if (!supabaseUrl || !supabaseKey) return context.next();

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 5-second timeout for Supabase fetches
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    let usernameRow: any;
    let savedArtists: any[];
    let collectionItems: any[] = [];

    try {
      // Look up the username row to check sharing flag + get user_id + location
      const { data: unameData } = await supabase
        .from('usernames')
        .select('user_id, username, saved_artists_public, location')
        .eq('username', handle)
        .maybeSingle()
        .abortSignal(controller.signal);

      if (!unameData) {
        clearTimeout(timeoutId);
        return context.next();
      }

      // Sharing not enabled — 404 via SPA fallback (which will also 404)
      if (!unameData.saved_artists_public) {
        clearTimeout(timeoutId);
        return context.next();
      }

      usernameRow = unameData;

      // Fetch saved artists
      const { data: savedData } = await supabase
        .from('saved_artists')
        .select(`
          artist_slug,
          artist_name,
          artist_image_url,
          supported,
          artists!left (slug, name, image_url)
        `)
        .eq('user_id', unameData.user_id)
        .eq('deleted', false)
        .abortSignal(controller.signal);

      savedArtists = savedData || [];

      // Public collection: purchased and not hidden only — the provenance gate is what
      // keeps the page honest (Support Loop Step 3).
      const { data: collectionData } = await supabase
        .from('collection_items')
        .select('title, artist_name, art_url, acquired_at, releases!left (slug, artwork_url, artists (slug))')
        .eq('user_id', unameData.user_id)
        .eq('provenance', 'purchased')
        .eq('hidden', false)
        .order('acquired_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(CRAWLER_COLLECTION_LIMIT)
        .abortSignal(controller.signal);

      collectionItems = collectionData || [];
    } catch {
      clearTimeout(timeoutId);
      return context.next();
    }

    clearTimeout(timeoutId);

    const ownerName = escapeHtml(usernameRow.username);
    const ownerLocation = usernameRow.location ? escapeHtml(usernameRow.location) : null;
    const pageUrl = `https://unstream.stream/u/${handle}`;

    // Collection tiles — matched items link to the release page so a viewer can buy the
    // same record. Everything interpolated is escaped.
    const collectionTilesHtml = collectionItems.map((row: any) => {
      const release = row.releases;
      const artistSlug = release?.artists?.slug || '';
      const title = escapeHtml(row.title || '');
      const artistName = escapeHtml(row.artist_name || '');
      const artUrl = row.art_url || release?.artwork_url || '';
      const artHtml = artUrl
        ? `<img src="${escapeHtml(artUrl)}" alt="${title} by ${artistName}" class="collection-art" loading="lazy">`
        : `<span class="collection-art-fallback">${title}</span>`;
      const caption = `<div class="collection-caption">${title}</div><div class="collection-caption caption-artist">${artistName}</div>`;
      const releaseUrl = release?.slug && artistSlug
        ? `https://unstream.stream/a/${escapeHtml(artistSlug)}/${escapeHtml(release.slug)}`
        : null;
      return releaseUrl
        ? `<a href="${releaseUrl}" class="collection-tile">${artHtml}${caption}</a>`
        : `<div class="collection-tile">${artHtml}${caption}</div>`;
    }).join('');

    const supportedCount = savedArtists.filter((row: any) => row.supported === true).length;
    const countParts: string[] = [];
    if (collectionItems.length > 0) {
      countParts.push(`${collectionItems.length} release${collectionItems.length === 1 ? '' : 's'} collected`);
    }
    if (supportedCount > 0) {
      countParts.push(`${supportedCount} artist${supportedCount === 1 ? '' : 's'} supported`);
    }

    // Build artist cards HTML
    const artistCardsHtml = savedArtists.length > 0
      ? savedArtists.map((row: any) => {
          const artistRow = row.artists;
          const slug = artistRow?.slug || row.artist_slug || '';
          const name = artistRow?.name || row.artist_name || 'Unknown';
          const imageUrl = artistRow?.image_url || row.artist_image_url || '';
          const supported = row.supported === true;
          const profileUrl = slug ? `https://unstream.stream/a/${escapeHtml(slug)}` : '#';
          const avatarHtml = imageUrl
            ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" class="artist-avatar" onerror="this.style.display='none';this.parentElement.querySelector('.avatar-fallback').style.display='flex'"><span class="artist-avatar avatar-fallback" style="display:none">${escapeHtml(name[0]?.toUpperCase() || '?')}</span>`
            : `<span class="artist-avatar">${escapeHtml(name[0]?.toUpperCase() || '?')}</span>`;
          const supportedBadge = supported
            ? '<span class="supported-badge"><svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg> Supported</span>'
            : '';

          return `<a href="${profileUrl}" class="artist-card">${avatarHtml}<div style="flex:1;min-width:0"><div class="artist-name">${escapeHtml(name)}</div>${supportedBadge}</div></a>`;
        }).join('')
      : (collectionTilesHtml ? '' : '<p style="color:var(--muted);text-align:center;padding:48px 0">No saved artists yet.</p>');

    // JSON-LD structured data
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${usernameRow.username}'s collection on Unstream`,
      url: pageUrl,
      description: `Music ${usernameRow.username} has bought and artists they support on Unstream — platforms that pay artists fairly.`,
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ownerName}'s collection - Unstream</title>
  <meta name="description" content="Music ${ownerName} has bought and artists they support on Unstream — platforms that pay artists fairly.">
  <meta property="og:title" content="${ownerName}'s collection - Unstream">
  <meta property="og:description" content="Music ${ownerName} has bought and artists they support on Unstream — platforms that pay artists fairly.">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Unstream">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${ownerName}'s collection - Unstream">
  <meta name="twitter:description" content="Music ${ownerName} has bought and artists they support on Unstream — platforms that pay artists fairly.">
  <link rel="canonical" href="${pageUrl}">
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <link href="https://fonts.googleapis.com/css2?family=Darker+Grotesque:wght@300..900&family=Stack+Sans+Headline:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <header class="site-header">
    <a href="/" class="brand">${LOGO_SVG} Unstream</a>
    <!-- Plain GET form, no JS: this page is pure SSR, so it can't render the
         React HeaderSearch. Submitting lands on /?q=… which is where the SPA
         renders results. Never point this at /search — that URL belongs to the
         noscript-search edge function. -->
    <form class="header-search" action="/" method="get" role="search">
      <input type="text" name="q" placeholder="Search artists..." aria-label="Search artists" enterkeyhint="search">
      <button type="submit">Search</button>
    </form>
  </header>

  <div class="page-content">
    <div class="container" style="padding-top:48px;padding-bottom:16px;text-align:center">
      <h1 style="font-size:24px;font-weight:700">${ownerName}'s collection</h1>
      ${ownerLocation ? `<p style="color:var(--text);font-size:14px;margin-top:4px">${ownerLocation}</p>` : ''}
      ${countParts.length > 0 ? `<p style="color:var(--muted);font-size:14px;margin-top:4px">${countParts.join(' &#x2022; ')}</p>` : ''}
      <div data-share-mount style="margin-top:24px">
        <button class="copy-btn" id="copy-url-btn" data-url="${pageUrl}">
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>
          <span id="copy-btn-label">Copy URL</span>
        </button>
      </div>
    </div>

    ${collectionTilesHtml ? `<div class="container" style="padding-bottom:40px">
      <div class="collection-grid">
        ${collectionTilesHtml}
      </div>
    </div>` : ''}

    <div class="container" style="padding-bottom:48px">
      ${collectionTilesHtml && savedArtists.length > 0 ? '<h2 style="font-size:18px;font-weight:600;margin-bottom:12px">Artists</h2>' : ''}
      <div style="display:grid;gap:8px">
        ${artistCardsHtml}
      </div>
    </div>
  </div>

  <div style="padding:24px 16px;text-align:center">
    <a href="https://unstream.stream" style="color:var(--text);text-decoration:none;font-weight:700;font-size:18px">Powered by Unstream</a>
    <p style="font-size:14px;color:var(--muted);margin-top:4px">Find music on platforms that pay artists fairly.</p>
  </div>

  <footer style="margin-top:auto;padding:24px 16px;border-top:1px solid var(--footer-border)">
    <div style="max-width:896px;margin:0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;font-size:14px;color:var(--muted)">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Made with love in Massachusetts, USA</a>
      <nav style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">
        <a href="/artists" style="color:var(--muted);text-decoration:none">Indie Artist Index</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/guides" style="color:var(--muted);text-decoration:none">Guides</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/changelog" style="color:var(--muted);text-decoration:none">Changelog</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://github.com/brandonlucasgreen/unstream" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Codebase</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/support" style="color:var(--muted);text-decoration:none">Support</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/privacy-policy" style="color:var(--muted);text-decoration:none">Privacy policy</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/terms" style="color:var(--muted);text-decoration:none">Terms of use</a>
      </nav>
    </div>
  </footer>

  <script>
    // Progressive enhancement: Copy URL button
    (function() {
      var btn = document.getElementById('copy-url-btn');
      if (!btn) return;
      var label = document.getElementById('copy-btn-label');
      btn.addEventListener('click', function() {
        var url = btn.getAttribute('data-url');
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(function() {
            btn.classList.add('copied');
            if (label) label.textContent = 'Copied!';
            setTimeout(function() {
              btn.classList.remove('copied');
              if (label) label.textContent = 'Copy URL';
            }, 2000);
          });
        }
      });
    })();
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=300',
        'Cache-Tag': `user-share-${handle}`,
      },
    });
  } catch {
    return context.next();
  }
}