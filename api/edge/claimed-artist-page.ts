import { Context } from "https://edge.netlify.com";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// UPDATE ANNUALLY: Bandcamp Friday dates from https://daily.bandcamp.com/features/bandcamp-fridays
const BANDCAMP_FRIDAY_DATES = [
  '2026-03-06', '2026-05-01', '2026-08-07',
  '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
];
function isBandcampFriday(): boolean {
  const pacificDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return BANDCAMP_FRIDAY_DATES.includes(pacificDate);
}

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
  peertube: { name: 'PeerTube', color: '#F1680D', icon: '▶️', category: 'social' },
  newsletter: { name: 'Newsletter', color: '#666', icon: '📧', category: 'social' },
  wikipedia: { name: 'Wikipedia', color: '#636466', icon: '📖', category: 'social' },
  liberapay: { name: 'Liberapay', color: '#F6C915', icon: '🤝', category: 'patronage' },
};

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SOCIAL_ICONS: Record<string, string> = {
  instagram: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#E4405F"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>',
  facebook: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
  tiktok: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#E0E0E0"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
  youtube: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
  threads: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#E0E0E0"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>',
  bluesky: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#0085FF"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z"/></svg>',
  mastodon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#858AFA"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/></svg>',
  peertube: '<svg width="16" height="16" viewBox="0 0 24 24" fill="#F1680D"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-1.243 17.07V6.93L18.258 12l-7.5 5.07z"/></svg>',
};

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
  const featuredEmbed = profile.featured_embed || '';
  const pageUrl = `https://unstream.stream/a/${slug}`;
  const description = bio || `Support ${artist.name} directly on platforms that pay artists fairly.`;

  // Separate main platforms from social; "other" and unknown platforms go to main
  const mainPlatforms = platforms.filter((p: { platform: string }) => {
    const info = PLATFORM_INFO[p.platform];
    return !info || info.category !== 'social';
  });
  const socialPlatforms = platforms.filter((p: { platform: string }) => {
    const info = PLATFORM_INFO[p.platform];
    return info?.category === 'social';
  });

  const bcFriday = isBandcampFriday();

  const platformLinksHtml = mainPlatforms.map((p: { platform: string; url: string; display_name?: string }) => {
    const info = PLATFORM_INFO[p.platform];
    const isOther = p.platform === 'other' || p.platform.startsWith('other_');
    const linkName = isOther ? escapeHtml(p.display_name || 'Link') : (info?.name || escapeHtml(p.display_name || p.platform));
    const linkColor = info?.color || '#71717a';
    const linkIcon = info ? (SOCIAL_ICONS[p.platform] ? `<span style="font-size:16px">${SOCIAL_ICONS[p.platform]}</span>` : info.icon) : '🔗';
    const isBCFriday = p.platform === 'bandcamp' && bcFriday;
    const payout = isBCFriday ? '~97%' : info?.payoutPercent;
    const payoutLabel = payout ? `<span style="font-size:12px;color:var(--muted)">${payout} to artist</span>` : '';
    const bcFridayLabel = isBCFriday ? `<span style="font-size:11px;font-weight:700;color:#1da0c3;animation:bc-pulse 2s ease-in-out infinite">Bandcamp Friday!</span>` : '';
    return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;border:1px solid ${isBCFriday ? '#1da0c340' : 'var(--border)'};background:${isBCFriday ? '#1da0c310' : linkColor + '08'};text-decoration:none;color:var(--text);transition:background 0.15s">
      <span style="font-size:20px;display:inline-flex;align-items:center;justify-content:center">${linkIcon}</span>
      <span style="flex:1;font-weight:500">${linkName}</span>
      ${payoutLabel}${bcFridayLabel}
    </a>`;
  }).join('');

  const socialLinksHtml = socialPlatforms.length > 0 ? `
    <div style="margin-top:24px">
      <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Follow</h2>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${socialPlatforms.map((p: { platform: string; url: string }) => {
          const info = PLATFORM_INFO[p.platform];
          if (!info) return '';
          const icon = SOCIAL_ICONS[p.platform] || info.icon;
          return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;border:1px solid var(--border);text-decoration:none;color:var(--text);font-size:14px">${icon} ${info.name}</a>`;
        }).join('')}
      </div>
    </div>
  ` : '';


  const featuredEmbedHtml = featuredEmbed ? `
    <div style="margin-top:24px">
      <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px">Featured Release</h2>
      <div style="border-radius:12px;overflow:hidden">${featuredEmbed}</div>
    </div>
  ` : '';

  // Build JSON-LD structured data for SEO
  const sameAsUrls = platforms.map((p: { url: string }) => p.url);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MusicGroup',
    name: artist.name,
    url: pageUrl,
    ...(imageUrl ? { image: imageUrl } : {}),
    ...(bio ? { description: profile.bio } : {}),
    ...(sameAsUrls.length > 0 ? { sameAs: sameAsUrls } : {}),
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${artistName} - Unstream | Listen on platforms that pay artists fairly</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${artistName} - Unstream">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:type" content="profile">
  <meta property="og:site_name" content="Unstream">
  ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="${artistName}">` : ''}
  <meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${artistName} - Unstream">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  ${imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : ''}
  <link rel="canonical" href="${pageUrl}">
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <link href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script>
    (function(){var s=localStorage.getItem('unstream-theme');var t=s||(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',t)})();
  </script>
  <style>
    :root { --bg: #0d0d0d; --bg2: #1a1a1a; --text: #f0f0f0; --muted: #999; --border: #2a2a2a; --accent: #ff6b35; --footer-border: #1a1a1a; }
    html[data-theme="light"] { --bg: #ffffff; --bg2: #f5f5f5; --text: #1a1a1a; --muted: #555; --border: #e0e0e0; --accent: #e55a2b; --footer-border: #e0e0e0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Golos Text', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    a { color: inherit; }
    .container { max-width: 640px; margin: 0 auto; padding: 0 24px; width: 100%; }
    .page-content { position: relative; flex: 1; display: flex; flex-direction: column; }
    .theme-toggle { position: absolute; top: 16px; right: 16px; background: none; border: none; cursor: pointer; color: var(--muted); padding: 8px; border-radius: 8px; z-index: 1; }
    .theme-toggle:hover { color: var(--text); background: var(--bg2); }
    @keyframes bc-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
    .theme-toggle svg { display: none; }
    .theme-toggle .icon-system { display: block; }
    .theme-toggle[data-pref="light"] .icon-system { display: none; }
    .theme-toggle[data-pref="light"] .icon-sun { display: block; }
    .theme-toggle[data-pref="dark"] .icon-system { display: none; }
    .theme-toggle[data-pref="dark"] .icon-moon { display: block; }
    .auth-bar { display: none; background: var(--bg2); border-bottom: 1px solid var(--border); padding: 8px 16px; font-size: 14px; }
    .auth-bar.visible { display: flex; align-items: center; justify-content: space-between; }
    .auth-bar a { color: var(--accent); text-decoration: none; font-weight: 500; }
    .auth-bar a:hover { text-decoration: underline; }
    .auth-bar .auth-left { display: flex; align-items: center; gap: 12px; }
    .auth-bar .auth-left span { color: var(--muted); }
    .auth-bar button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; font-family: inherit; }
    .auth-bar button:hover { color: var(--text); }
  </style>
</head>
<body>
  <div class="auth-bar" id="auth-bar">
    <div class="auth-left">
      <span>Logged in as <strong id="auth-email" style="color:var(--text)"></strong></span>
      <a href="/artist-dashboard">Dashboard</a>
    </div>
    <button onclick="(function(){for(var k in localStorage){if(k.match(/^sb-.*-auth-token$/)){localStorage.removeItem(k)}}document.getElementById('auth-bar').classList.remove('visible');window.location.href='/artist-login'})()">Sign out</button>
  </div>
  <script>
    (function(){for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.match(/^sb-.*-auth-token$/)){try{var d=JSON.parse(localStorage.getItem(k));if(d&&d.access_token){document.getElementById('auth-bar').classList.add('visible');try{var p=JSON.parse(atob(d.access_token.split('.')[1]));if(p.email)document.getElementById('auth-email').textContent=p.email}catch(e){}}}catch(e){}break}}})();
  </script>
  <div class="page-content">
  <button class="theme-toggle" id="theme-toggle-btn" aria-label="Toggle theme">
    <svg class="icon-system" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
    <svg class="icon-sun" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
    <svg class="icon-moon" width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
  </button>
  <script>
    (function(){
      var btn=document.getElementById('theme-toggle-btn');
      var pref=localStorage.getItem('unstream-theme')||'system';
      btn.setAttribute('data-pref',pref);
      btn.title=(pref==='system'?'Using system theme':pref==='light'?'Light mode':'Dark mode')+' — click to change';
      btn.onclick=function(){
        var next=pref==='system'?'light':pref==='light'?'dark':'system';
        pref=next;
        btn.setAttribute('data-pref',next);
        if(next==='system'){
          localStorage.removeItem('unstream-theme');
          var resolved=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';
          document.documentElement.setAttribute('data-theme',resolved);
        }else{
          localStorage.setItem('unstream-theme',next);
          document.documentElement.setAttribute('data-theme',next);
        }
        btn.title=(next==='system'?'Using system theme':next==='light'?'Light mode':'Dark mode')+' — click to change';
      };
    })();
  </script>
  <!-- Hero -->
  <div class="container" style="padding-top:48px;padding-bottom:32px;text-align:center">
    ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${artistName}" style="width:128px;height:128px;border-radius:50%;object-fit:cover;border:2px solid var(--border);margin-bottom:16px">` : ''}
    <div style="display:flex;align-items:center;justify-content:center;gap:8px">
      <h1 style="font-size:28px;font-weight:700">${artistName}</h1>
      <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:500;background:rgba(255,107,53,0.15);color:var(--accent)">
        <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
        Verified
      </span>
    </div>
  </div>

  <!-- Platform Links -->
  <div class="container" style="padding-bottom:32px">
    ${bio ? `<p style="color:var(--muted);font-size:14px;margin-bottom:24px;text-align:left">${bio}</p>` : ''}
    ${featuredEmbedHtml}
    ${mainPlatforms.length > 0 ? `
      <h2 style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:12px${featuredEmbed ? ';margin-top:24px' : ''}">Support directly</h2>
      <div style="display:grid;gap:8px">${platformLinksHtml}</div>
    ` : ''}
    ${socialLinksHtml}
  </div>

  <!-- Embed Section -->
  <div class="container" style="padding-bottom:32px">
    <button id="embed-toggle" style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--muted);background:none;border:none;cursor:pointer;font-family:inherit;padding:0" onclick="document.getElementById('embed-panel').style.display=document.getElementById('embed-panel').style.display==='none'?'block':'none';this.querySelector('svg').style.transform=document.getElementById('embed-panel').style.display==='none'?'':'rotate(90deg)'">
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="transition:transform 0.15s"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
      Embed this profile on your website
    </button>
    <div id="embed-panel" style="display:none;margin-top:16px">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:16px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:var(--muted)">Theme:</span>
          <button class="theme-btn" data-theme="dark" style="padding:4px 10px;border-radius:4px;font-size:12px;font-weight:500;border:none;cursor:pointer;font-family:inherit;background:rgba(255,107,53,0.15);color:var(--accent)" onclick="setEmbedTheme('dark')">Dark</button>
          <button class="theme-btn" data-theme="light" style="padding:4px 10px;border-radius:4px;font-size:12px;font-weight:500;border:none;cursor:pointer;font-family:inherit;background:var(--bg2);color:var(--muted)" onclick="setEmbedTheme('light')">Light</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:var(--muted)">Links: <span id="link-count">6</span></span>
          <input type="range" min="3" max="12" value="6" id="max-links" style="width:80px;accent-color:var(--accent)" oninput="updateEmbed()">
        </div>
      </div>
      <div id="embed-preview" style="background:var(--bg);border-radius:8px;padding:16px;margin-bottom:12px;display:flex;justify-content:center"></div>
      <div style="position:relative">
        <pre id="embed-code" style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:16px;padding-right:64px;overflow-x:auto;font-size:12px;color:var(--muted);font-family:monospace;white-space:pre-wrap;word-break:break-all"></pre>
        <button onclick="navigator.clipboard.writeText(document.getElementById('embed-code').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)" style="position:absolute;top:8px;right:8px;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:500;border:none;cursor:pointer;font-family:inherit;background:rgba(255,107,53,0.1);color:var(--accent)">Copy</button>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-top:8px">Paste this into your website's HTML. The widget loads asynchronously and won't affect your page speed.</p>
    </div>
  </div>

  <!-- Powered by Unstream -->
  <div style="padding:24px 16px;text-align:center">
    <a href="https://unstream.stream" style="color:var(--text);text-decoration:none;font-weight:700;font-size:18px">Powered by Unstream</a>
    <p style="font-size:14px;color:var(--muted);margin-top:4px">Find music on platforms that pay artists fairly.</p>
  </div>
  <!-- Footer -->
  <footer style="margin-top:auto;padding:24px 16px;border-top:1px solid var(--footer-border)">
    <div style="max-width:896px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:12px;font-size:14px;color:var(--muted)">
      <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Made with love in Massachusetts, USA</a>
      <nav style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px">
        <a href="/artist-login" style="color:var(--muted);text-decoration:none">Artist login</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/artists" style="color:var(--muted);text-decoration:none">Index</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://unstream.featurebase.app/roadmap" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Roadmap</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="mailto:support@unstream.stream" style="color:var(--muted);text-decoration:none">Support</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="https://liberapay.com/brandonlucasgreen/donate" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:none">Donate</a>
        <span style="color:var(--muted);opacity:0.4;font-size:10px">&#x2022;</span>
        <a href="/privacy-policy" style="color:var(--muted);text-decoration:none">Privacy</a>
      </nav>
    </div>
  </footer>
  </div>

  <script>
    var embedTheme = 'dark';
    var artistName = ${JSON.stringify(artist.name)};
    function setEmbedTheme(t) {
      embedTheme = t;
      document.querySelectorAll('.theme-btn').forEach(function(b) {
        if (b.getAttribute('data-theme') === t) {
          b.style.background = 'rgba(255,107,53,0.15)';
          b.style.color = '#ff6b35';
        } else {
          b.style.background = 'var(--bg2)';
          b.style.color = '#999';
        }
      });
      updateEmbed();
    }
    function updateEmbed() {
      var maxLinks = document.getElementById('max-links').value;
      document.getElementById('link-count').textContent = maxLinks;
      var code = '<div class="unstream-widget" data-artist="' + artistName + '" data-theme="' + embedTheme + '" data-max-links="' + maxLinks + '"></div>\\n<script src="https://unstream.stream/widget.js" async><\\/script>';
      document.getElementById('embed-code').textContent = code;
      // Live preview
      var container = document.getElementById('embed-preview');
      container.innerHTML = '';
      container.style.background = embedTheme === 'light' ? '#f0f0f0' : '#0d0d0d'; // embed preview bg stays fixed per embed theme selection
      var w = document.createElement('div');
      w.className = 'unstream-widget';
      w.setAttribute('data-artist', artistName);
      w.setAttribute('data-theme', embedTheme);
      w.setAttribute('data-max-links', maxLinks);
      container.appendChild(w);
      var s = document.createElement('script');
      s.src = '/widget.js';
      s.async = true;
      container.appendChild(s);
    }
    updateEmbed();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=300',
      'Cache-Tag': `artist-${slug}`,
    },
  });
}
