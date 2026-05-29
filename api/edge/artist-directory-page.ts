import { Context } from "https://edge.netlify.com";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function handler(request: Request, context: Context) {
  try {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_KEY");
  if (!supabaseUrl || !supabaseKey) return context.next();

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch verified artist profiles
  const { data: profiles } = await supabase
    .from('artist_profiles')
    .select('artist_id, custom_image_url')
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

  const customImageMap = new Map(
    profiles.filter((p: { custom_image_url?: string }) => p.custom_image_url).map((p: { artist_id: string; custom_image_url: string }) => [p.artist_id, p.custom_image_url])
  );

  const artists = (artistRows || []).map((a: { id: string; slug: string; name: string; image_url?: string }) => ({
    slug: a.slug,
    name: a.name,
    imageUrl: customImageMap.get(a.id) || a.image_url || null,
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
  <title>Indie Artist Index - Unstream</title>
  <meta name="description" content="Browse verified artists on Unstream. Find where to support your favorite independent musicians on platforms that pay artists fairly.">
  <meta property="og:title" content="Indie Artist Index - Unstream">
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
    :root { --bg: #0d0d0d; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; }
    html[data-theme="light"] { --bg: #ffffff; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Golos Text', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    .container { max-width: 720px; margin: 0 auto; padding: 0 24px; width: 100%; }
    .theme-toggle { background: none; border: none; cursor: pointer; color: var(--muted); padding: 8px; border-radius: 8px; }
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
    "name": "Indie Artist Index",
    "description": "Browse verified artists on Unstream",
    "url": "${pageUrl}",
    "isPartOf": { "@type": "WebSite", "name": "Unstream", "url": "${new URL(request.url).origin}" },
    "numberOfItems": ${artists.length}
  }
  </script>
</head>
<body>
  <!-- Header nav -->
  <header style="padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:16px">
    <a href="/" style="font-size:20px;font-weight:700;color:var(--text);text-decoration:none;display:flex;align-items:center;gap:8px">
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 110 110" aria-hidden="true">
        <defs><filter id="gs"><feColorMatrix type="saturate" values="0"/></filter></defs>
        <g transform="translate(22,22) scale(1.8333)" filter="url(#gs)">
          <path fill="#50A5E6" d="M30 22c-3 0-6.688 7.094-7 10-.421 3.915 2 4 2 4h11V26s-3.438-4-6-4z"/>
          <ellipse transform="rotate(-60 27.574 28.49)" fill="#1C6399" cx="27.574" cy="28.489" rx="5.848" ry="1.638"/>
          <path fill="#F9CA55" d="M20.086 0c1.181 0 2.138.957 2.138 2.138 0 .789.668 10.824.668 10.824L17.948 18V2.138C17.948.957 18.905 0 20.086 0z"/>
          <path fill="#FFDC5D" d="M18.875 4.323c0-1.099.852-1.989 1.903-1.989 1.051 0 1.903.891 1.903 1.989 0 0 .535 5.942 1.192 9.37.878 1.866 1.369 4.682 1.261 6.248.054.398 5.625 5.006 5.625 5.006-.281 1.813-2.259 6.155-4.759 8.159l-3.521-2.924c-2.885-.404-4.458-3.331-4.458-4.264 0-2.984.854-21.595.854-21.595z"/>
          <path fill="#50A5E6" d="M6 22c3 0 6.688 7.094 7 10 .421 3.915-2 4-2 4H0V26s3.438-4 6-4z"/>
          <ellipse transform="rotate(-30 8.424 28.489)" fill="#1C6399" cx="8.426" cy="28.489" rx="1.638" ry="5.848"/>
          <path fill="#F9CA55" d="M16.061.011c-1.266-.127-2.333.864-2.333 2.103 0 .78-.184 10.319-.184 10.319L17.895 18l.062-15.765c0-1.106-.795-2.114-1.896-2.224z"/>
          <path fill="#FFDC5D" d="M17.125 4.323c0-1.099-.852-1.989-1.903-1.989-1.051 0-1.903.891-1.903 1.989 0 0-.535 5.942-1.192 9.37-.878 1.866-1.369 4.682-1.261 6.248-.054.398-5.625 5.006-5.625 5.006C5.522 26.76 7.5 31.102 10 33.106l3.521-2.924c2.885-.404 4.458-3.331 4.458-4.264 0-2.984-.854-21.595-.854-21.595z"/>
          <path fill="#F9CA55" d="M17.958 25.823c-.414 0-.75-.336-.75-.75V2.792c0-.414.336-.75.75-.75s.75.336.75.75v22.282c.001.413-.335.749-.75.749z"/>
        </g>
        <path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke="var(--text)" stroke-width="8" stroke-linecap="round"/>
        <line x1="14" y1="52" x2="14" y2="64" stroke="var(--text)" stroke-width="7" stroke-linecap="round"/>
        <line x1="96" y1="52" x2="96" y2="64" stroke="var(--text)" stroke-width="7" stroke-linecap="round"/>
        <rect x="3" y="60" width="22" height="28" rx="9" fill="var(--text)"/>
        <rect x="85" y="60" width="22" height="28" rx="9" fill="var(--text)"/>
      </svg>
      Unstream
    </a>
    <div style="display:flex;align-items:center;gap:12px;font-size:14px">
      <a href="/login" style="color:var(--muted);text-decoration:none;transition:color 0.15s">Login</a>
      <button class="theme-toggle" data-pref="" onclick="(function(b){var c=['system','light','dark'];var cur=localStorage.getItem('unstream-theme')||'system';var i=(c.indexOf(cur)+1)%3;var n=c[i];localStorage.setItem('unstream-theme',n);b.setAttribute('data-pref',n==='system'?'':n);if(n==='light')document.documentElement.setAttribute('data-theme','light');else if(n==='dark'){document.documentElement.removeAttribute('data-theme');document.documentElement.setAttribute('data-theme','dark');}else{document.documentElement.removeAttribute('data-theme');if(window.matchMedia&&window.matchMedia('(prefers-color-scheme:light)').matches)document.documentElement.setAttribute('data-theme','light');};})(this)">
        <svg class="icon-system" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
        <svg class="icon-sun" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
        <svg class="icon-moon" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
      </button>
    </div>
  </header>

  <!-- Page heading -->
  <div style="padding:32px 24px;text-align:center">
    <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Indie Artist Index</h1>
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
  <!-- Footer -->
  <footer style="margin-top:auto;padding:24px 16px;border-top:1px solid var(--border)">
    <div style="max-width:896px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:12px;font-size:14px;color:var(--muted)">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Made with love in Massachusetts, USA</a>
      <nav style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">
        <a href="/artists" style="color:var(--muted);text-decoration:none">Indie Artist Index</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/guides" style="color:var(--muted);text-decoration:none">Guides</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://github.com/users/brandonlucasgreen/projects/4" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Roadmap</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://github.com/brandonlucasgreen/unstream" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Codebase</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/support" style="color:var(--muted);text-decoration:none">Support</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://letterbird.co/hi-d2078591" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Contact</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/privacy-policy" style="color:var(--muted);text-decoration:none">Privacy policy</a>
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
  } catch {
    // If anything fails, fall through to the SPA
    return context.next();
  }
}
