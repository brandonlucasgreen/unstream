import { Context } from "https://edge.netlify.com";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function handler(request: Request, context: Context) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_KEY");
  if (!supabaseUrl || !supabaseKey) return context.next();

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch verified artist profiles
  const { data: profiles } = await supabase
    .from('artist_profiles')
    .select('artist_id')
    .not('verified_at', 'is', null);

  if (!profiles || profiles.length === 0) {
    // No verified artists yet — fall through to SPA
    return context.next();
  }

  // Fetch artist details separately (no FK join needed)
  const artistIds = profiles.map((p: { artist_id: string }) => p.artist_id);
  const { data: artistRows } = await supabase
    .from('artists')
    .select('id, name, slug, image_url')
    .in('id', artistIds);

  const artists = (artistRows || []).map((a: { slug: string; name: string; image_url?: string }) => ({
    slug: a.slug,
    name: a.name,
    imageUrl: a.image_url || null,
  })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  // Group by first letter
  const grouped: Record<string, typeof artists> = {};
  for (const artist of artists) {
    const letter = (artist.name[0] || '#').toUpperCase();
    const key = /[A-Z]/.test(letter) ? letter : '#';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(artist);
  }
  const sortedLetters = Object.keys(grouped).sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  const pageUrl = `${new URL(request.url).origin}/artists`;

  // Build letter nav
  const letterNav = sortedLetters.map(letter =>
    `<a href="#letter-${letter}" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:var(--bg2);border:1px solid var(--border);text-decoration:none;color:var(--text);font-weight:600;font-size:14px;transition:border-color 0.15s">${letter}</a>`
  ).join('');

  // Build artist groups
  const groupsHtml = sortedLetters.map(letter => {
    const items = grouped[letter].map(a => {
      const imgHtml = a.imageUrl
        ? `<img src="${escapeHtml(a.imageUrl)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--bg2);flex-shrink:0" />`
        : `<div style="width:36px;height:36px;border-radius:50%;background:var(--bg2);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;color:var(--muted)">${escapeHtml(a.name[0]?.toUpperCase() || '?')}</div>`;
      return `<a href="/a/${escapeHtml(a.slug)}" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;text-decoration:none;color:var(--text);transition:background 0.15s;border:1px solid transparent" onmouseover="this.style.background='var(--bg2)';this.style.borderColor='var(--border)'" onmouseout="this.style.background='transparent';this.style.borderColor='transparent'">
        ${imgHtml}
        <span style="font-size:15px;font-weight:500">${escapeHtml(a.name)}</span>
        <svg style="margin-left:auto;flex-shrink:0" width="14" height="14" fill="none" stroke="var(--muted)" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
      </a>`;
    }).join('');

    return `<div id="letter-${letter}" style="scroll-margin-top:80px">
      <h2 style="font-size:20px;font-weight:700;color:var(--text);padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:4px">${letter}</h2>
      <div style="display:grid;gap:2px">${items}</div>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Artist Directory - Unstream</title>
  <meta name="description" content="Browse verified artists on Unstream. Find where to support your favorite independent musicians on platforms that pay artists fairly.">
  <meta property="og:title" content="Artist Directory - Unstream">
  <meta property="og:description" content="Browse verified artists on Unstream. Find where to support your favorite independent musicians on platforms that pay artists fairly.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:site_name" content="Unstream">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="${pageUrl}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script>
    (function(){var t=localStorage.getItem('unstream-theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');else if(t==='dark')document.documentElement.setAttribute('data-theme','dark');else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches)document.documentElement.setAttribute('data-theme','light');})();
  </script>
  <style>
    :root { --bg: #0d0d0d; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; --footer-border: #1a1a1a; }
    html[data-theme="light"] { --bg: #ffffff; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; --footer-border: #e0e0e0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Golos Text', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    .page-content { position: relative; flex: 1; display: flex; flex-direction: column; }
    .container { max-width: 720px; margin: 0 auto; padding: 0 24px; width: 100%; }
    .theme-toggle { position: absolute; top: 16px; right: 16px; background: none; border: none; cursor: pointer; color: var(--muted); padding: 8px; border-radius: 8px; z-index: 1; }
    .theme-toggle:hover { color: var(--text); background: var(--bg2); }
    .theme-toggle svg { display: none; }
    .theme-toggle .icon-system { display: block; }
    .theme-toggle[data-pref="light"] .icon-system { display: none; }
    .theme-toggle[data-pref="light"] .icon-sun { display: block; }
    .theme-toggle[data-pref="dark"] .icon-system { display: none; }
    .theme-toggle[data-pref="dark"] .icon-moon { display: block; }
  </style>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "name": "Artist Directory",
    "description": "Browse verified artists on Unstream",
    "url": "${pageUrl}",
    "isPartOf": { "@type": "WebSite", "name": "Unstream", "url": "${new URL(request.url).origin}" },
    "numberOfItems": ${artists.length}
  }
  </script>
</head>
<body>
  <div class="page-content">
  <button class="theme-toggle" data-pref="${""}" onclick="(function(b){var c=['system','light','dark'];var cur=localStorage.getItem('unstream-theme')||'system';var i=(c.indexOf(cur)+1)%3;var n=c[i];localStorage.setItem('unstream-theme',n);b.setAttribute('data-pref',n==='system'?'':n);if(n==='light')document.documentElement.setAttribute('data-theme','light');else if(n==='dark'){document.documentElement.removeAttribute('data-theme');document.documentElement.setAttribute('data-theme','dark');}else{document.documentElement.removeAttribute('data-theme');if(window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches)document.documentElement.setAttribute('data-theme','light');};})(this)">
    <svg class="icon-system" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
    <svg class="icon-sun" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
    <svg class="icon-moon" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
  </button>

  <!-- Header -->
  <div style="padding:48px 24px 32px;text-align:center">
    <a href="/" style="text-decoration:none;color:var(--text)">
      <h2 style="font-size:14px;font-weight:600;color:var(--muted);letter-spacing:0.05em;text-transform:uppercase;margin-bottom:4px">Unstream</h2>
    </a>
    <h1 style="font-size:28px;font-weight:700;margin-bottom:8px">Artist Directory</h1>
    <p style="color:var(--muted);font-size:15px;max-width:480px;margin:0 auto">${artists.length} verified artist${artists.length !== 1 ? 's' : ''} on platforms that pay fairly</p>
  </div>

  <!-- Letter navigation -->
  <div class="container" style="margin-bottom:32px">
    <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">
      ${letterNav}
    </div>
  </div>

  <!-- Artist groups -->
  <div class="container" style="padding-bottom:48px">
    <div style="display:grid;gap:32px">
      ${groupsHtml}
    </div>
  </div>
  </div>

  <!-- Footer -->
  <footer style="margin-top:auto;padding:24px 16px;border-top:1px solid var(--footer-border)">
    <div style="max-width:896px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:12px;font-size:14px;color:var(--muted)">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Made with love in Massachusetts, USA</a>
      <nav style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">
        <a href="/artists" style="color:var(--accent);text-decoration:none;font-weight:500">Artist index</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/artist-login" style="color:var(--muted);text-decoration:none">Login</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://unstream.featurebase.app/roadmap" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Roadmap</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://unstream.goatcounter.com" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Metrics</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="mailto:support@unstream.stream" style="color:var(--muted);text-decoration:none">Support</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://liberapay.com/brandonlucasgreen/donate" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Donate</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/privacy-policy" style="color:var(--muted);text-decoration:none">Privacy</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
