import { Context } from "https://edge.netlify.com";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLATFORM_INFO: Record<string, { name: string; color: string; icon: string; category: string; payoutPercent?: string }> = {
  bandcamp: { name: 'Bandcamp', color: '#1da0c3', icon: '🎵', category: 'marketplace', payoutPercent: '80-85%' },
  mirlo: { name: 'Mirlo', color: '#6366f1', icon: '🪺', category: 'marketplace', payoutPercent: '86-90%' },
  ampwall: { name: 'Ampwall', color: '#ef4444', icon: '🔊', category: 'marketplace', payoutPercent: '92-95%' },
  bandwagon: { name: 'Bandwagon', color: '#8b5cf6', icon: '🚐', category: 'decentralized' },
  faircamp: { name: 'Faircamp', color: '#22c55e', icon: '🏕️', category: 'decentralized', payoutPercent: '90-97%' },
  patreon: { name: 'Patreon', color: '#ff424d', icon: '🎨', category: 'patronage', payoutPercent: '86-90%' },
  qobuz: { name: 'Qobuz', color: '#0070f3', icon: '💿', category: 'marketplace', payoutPercent: '~70%' },
  jamcoop: { name: 'Jam.coop', color: '#e11d48', icon: '🎸', category: 'marketplace' },
  officialsite: { name: 'Official Site', color: '#71717a', icon: '🌐', category: 'official' },
  discogs: { name: 'Discogs', color: '#333333', icon: '💿', category: 'marketplace' },
  hoopla: { name: 'Hoopla', color: '#9333ea', icon: '🎧', category: 'library' },
  freegal: { name: 'Freegal', color: '#e91e63', icon: '🎵', category: 'library' },
  funkwhale: { name: 'Funkwhale', color: '#0084c7', icon: '🐋', category: 'decentralized' },
  internetarchive: { name: 'Internet Archive', color: '#428bca', icon: '🏛️', category: 'library' },
  instagram: { name: 'Instagram', color: '#E4405F', icon: '📷', category: 'social' },
  facebook: { name: 'Facebook', color: '#1877F2', icon: '📘', category: 'social' },
  tiktok: { name: 'TikTok', color: '#E0E0E0', icon: '🎬', category: 'social' },
  youtube: { name: 'YouTube', color: '#FF0000', icon: '▶️', category: 'social' },
  threads: { name: 'Threads', color: '#E0E0E0', icon: '🧵', category: 'social' },
  bluesky: { name: 'Bluesky', color: '#0085FF', icon: '🦋', category: 'social' },
  mastodon: { name: 'Mastodon', color: '#6364FF', icon: '🦣', category: 'social' },
};

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/a\//, '').replace(/\/$/, '');

  if (!slug) return context.next();

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_KEY");
  if (!supabaseUrl || !supabaseKey) return context.next();

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch artist
  const { data: artist } = await supabase
    .from('artists')
    .select('*')
    .eq('slug', slug)
    .single();

  if (!artist || artist.match_confidence !== 'claimed') return context.next();

  // Fetch profile
  const { data: profile } = await supabase
    .from('artist_profiles')
    .select('*')
    .eq('artist_id', artist.id)
    .single();

  if (!profile?.verified_at) return context.next();

  // Fetch links
  const { data: links } = await supabase
    .from('artist_links')
    .select('*')
    .eq('artist_id', artist.id)
    .order('display_order', { ascending: true, nullsFirst: false });

  const platforms = (links || []).filter((l: { url: string }) => {
    const u = l.url.toLowerCase();
    return !u.includes('duckduckgo.com') && !u.includes('google.com/search') && !u.includes('searchstyle=search');
  });

  const imageUrl = profile.custom_image_url || artist.image_url || '';
  const artistName = escapeHtml(artist.name);
  const bio = profile.bio ? escapeHtml(profile.bio) : '';
  const pageUrl = `https://unstream.stream/a/${slug}`;
  const description = bio || `Support ${artist.name} directly on platforms that pay artists fairly.`;

  // Separate main platforms from social
  const mainPlatforms = platforms.filter((p: { platform: string }) => {
    const info = PLATFORM_INFO[p.platform];
    return info && info.category !== 'social';
  });
  const socialPlatforms = platforms.filter((p: { platform: string }) => {
    const info = PLATFORM_INFO[p.platform];
    return info?.category === 'social';
  });

  const platformLinksHtml = mainPlatforms.map((p: { platform: string; url: string }) => {
    const info = PLATFORM_INFO[p.platform];
    if (!info) return '';
    const payoutLabel = info.payoutPercent ? `<span style="font-size:12px;color:#999">${info.payoutPercent} to artist</span>` : '';
    return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;border:1px solid #2a2a2a;background:${info.color}08;text-decoration:none;color:#f0f0f0;transition:background 0.15s">
      <span style="font-size:20px">${info.icon}</span>
      <span style="flex:1;font-weight:500">${info.name}</span>
      ${payoutLabel}
    </a>`;
  }).join('');

  const socialLinksHtml = socialPlatforms.length > 0 ? `
    <div style="margin-top:24px">
      <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin-bottom:12px">Follow</h2>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${socialPlatforms.map((p: { platform: string; url: string }) => {
          const info = PLATFORM_INFO[p.platform];
          if (!info) return '';
          return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;border:1px solid #2a2a2a;text-decoration:none;color:#f0f0f0;font-size:14px">${info.icon} ${info.name}</a>`;
        }).join('')}
      </div>
    </div>
  ` : '';

  const websiteHtml = profile.website_url ? `
    <div style="margin-top:24px">
      <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin-bottom:8px">Website</h2>
      <a href="${escapeHtml(profile.website_url)}" target="_blank" rel="noopener noreferrer" style="color:#ff6b35;text-decoration:none;font-size:14px">${escapeHtml(new URL(profile.website_url).hostname.replace(/^www\./, ''))}</a>
    </div>
  ` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${artistName} — Unstream</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${artistName} — Unstream">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:type" content="profile">
  ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">` : ''}
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="${pageUrl}">
  <link href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Golos Text', system-ui, sans-serif; background: #0d0d0d; color: #f0f0f0; min-height: 100vh; display: flex; flex-direction: column; }
    a { color: inherit; }
    .container { max-width: 640px; margin: 0 auto; padding: 0 24px; width: 100%; }
  </style>
</head>
<body>
  <!-- Hero -->
  <div class="container" style="padding-top:48px;padding-bottom:32px;text-align:center">
    ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${artistName}" style="width:128px;height:128px;border-radius:50%;object-fit:cover;border:2px solid #2a2a2a;margin-bottom:16px">` : ''}
    <div style="display:flex;align-items:center;justify-content:center;gap:8px">
      <h1 style="font-size:28px;font-weight:700">${artistName}</h1>
      <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;background:rgba(255,107,53,0.15);color:#ff6b35">
        <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
        Claimed
      </span>
    </div>
    ${bio ? `<p style="margin-top:8px;color:#999;font-size:14px;max-width:400px;margin-left:auto;margin-right:auto">${bio}</p>` : ''}
  </div>

  <!-- Platform Links -->
  <div class="container" style="padding-bottom:32px">
    ${mainPlatforms.length > 0 ? `
      <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin-bottom:12px">Support directly</h2>
      <div style="display:grid;gap:8px">${platformLinksHtml}</div>
    ` : ''}
    ${socialLinksHtml}
    ${websiteHtml}
  </div>

  <!-- Footer -->
  <footer style="margin-top:auto;padding:24px;text-align:center;border-top:1px solid #1a1a1a">
    <a href="https://unstream.stream" style="font-size:14px;color:#999;text-decoration:none">Powered by Unstream</a>
    <p style="font-size:12px;color:#666;margin-top:4px">Find music on platforms that pay artists fairly.</p>
  </footer>

  <!-- SPA hydration -->
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 's-maxage=300, stale-while-revalidate',
    },
  });
}
