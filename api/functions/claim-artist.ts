// API endpoint: POST /api/claim
// Handles two actions:
//   action: 'start'  — create a pending claim (requires auth)
//   action: 'verify' — scrape website, verify link-back, discover platform links

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

const PLATFORM_PATTERNS: [string, RegExp][] = [
  ['bandcamp', /([a-z0-9-]+)\.bandcamp\.com/i],
  ['mirlo', /mirlo\.space/i],
  ['faircamp', /\.faircamp\./i],
  ['bandwagon', /bandwagon\.fm/i],
  ['qobuz', /qobuz\.com.*\/interpreter\//i],
  ['patreon', /patreon\.com\/[a-z0-9_-]+/i],
  ['kofi', /ko-fi\.com\/[a-z0-9_-]+/i],
  ['buymeacoffee', /buymeacoffee\.com\/[a-z0-9_-]+/i],
  ['instagram', /instagram\.com\/[a-z0-9_.]+/i],
  ['facebook', /facebook\.com\/[a-z0-9_.]+/i],
  ['tiktok', /tiktok\.com\/@[a-z0-9_.]+/i],
  ['youtube', /(youtube\.com\/(c\/|channel\/|@)[a-z0-9_-]+|youtu\.be)/i],
  ['threads', /threads\.net\/@?[a-z0-9_.]+/i],
  ['bluesky', /bsky\.app\/profile\/[a-z0-9.-]+/i],
  ['mastodon', /(@[a-z0-9_]+@[a-z0-9.-]+|[a-z0-9.-]+\/@[a-z0-9_]+)/i],
  ['discogs', /discogs\.com\/(artist|user)\//i],
  ['musicbrainz', /musicbrainz\.org\/artist\//i],
  ['funkwhale', /funkwhale\./i],
  ['jamcoop', /jam\.coop/i],
  ['ampwall', /ampwall\.com\/artist\//i],
  ['listenbrainz', /listenbrainz\.org\/user\//i],
  ['librefm', /libre\.fm\/user\//i],
  ['internetarchive', /archive\.org\/(details|search)/i],
];

// Reuse the same service client from db.ts (proven to work with RLS)
function getServiceClient() {
  return getClient();
}

// Verify the JWT from the request and return the user ID + email
async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  // Use anon client to verify the JWT
  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email || '' };
}

function generateVerificationCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Validate a URL is safe for server-side fetching (SSRF protection)
function isUrlSafeToFetch(urlString: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Only allow HTTP(S)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { safe: false, reason: 'Only HTTP/HTTPS URLs are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return { safe: false, reason: 'Localhost URLs are not allowed' };
  }

  // Block private/reserved IP ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return { safe: false, reason: 'Private IP not allowed' };
    if (a === 172 && b >= 16 && b <= 31) return { safe: false, reason: 'Private IP not allowed' };
    if (a === 192 && b === 168) return { safe: false, reason: 'Private IP not allowed' };
    if (a === 169 && b === 254) return { safe: false, reason: 'Link-local IP not allowed' }; // AWS metadata
    if (a === 0) return { safe: false, reason: 'Reserved IP not allowed' };
  }

  // Block common cloud metadata endpoints
  if (hostname === 'metadata.google.internal' || hostname === 'metadata.google') {
    return { safe: false, reason: 'Cloud metadata endpoint not allowed' };
  }

  return { safe: true };
}

interface ScrapeResult {
  links: string[];
  html: string;
}

// Scrape a website and extract all <a href> links + raw HTML
async function scrapeWebsite(websiteUrl: string): Promise<ScrapeResult | null> {
  const urlCheck = isUrlSafeToFetch(websiteUrl);
  if (!urlCheck.safe) {
    console.warn(`[Claim] SSRF blocked: ${websiteUrl} — ${urlCheck.reason}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(websiteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UnstreamBot/1.0; +https://unstream.stream)',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) return null;

    const html = await response.text();
    const links: string[] = [];
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let match;

    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];
      if (href.startsWith('http://') || href.startsWith('https://')) {
        links.push(href);
      }
    }

    return { links, html };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Check if the page content references the artist name
// Looks in: page title, meta tags, visible text, URL slugs
function pageReferencesArtist(html: string, artistName: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedName = normalize(artistName);
  if (!normalizedName) return false;

  // Split artist name into words for partial matching
  // e.g., "Kid Lightbulbs" → ["kid", "lightbulbs"]
  const nameWords = artistName.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  // Strip HTML tags to get visible text
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  const normalizedText = normalize(textContent);

  // Check 1: Full artist name appears in page text
  if (normalizedText.includes(normalizedName)) return true;

  // Check 2: Extract <title> and check it
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && normalize(titleMatch[1]).includes(normalizedName)) return true;

  // Check 3: Check meta tags (og:title, description, etc.)
  const metaRegex = /content=["']([^"']+)["']/gi;
  let metaMatch;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    if (normalize(metaMatch[1]).includes(normalizedName)) return true;
  }

  // Check 4: All name words appear somewhere on the page (handles slight variations)
  if (nameWords.length > 1) {
    const allWordsPresent = nameWords.every(word => normalizedText.includes(word));
    if (allWordsPresent) return true;
  }

  return false;
}

// Match discovered links to known platforms
function identifyPlatformLinks(links: string[]): { platform: string; url: string }[] {
  const found: { platform: string; url: string }[] = [];
  const seenPlatforms = new Set<string>();

  for (const link of links) {
    for (const [platform, pattern] of PLATFORM_PATTERNS) {
      if (!seenPlatforms.has(platform) && pattern.test(link)) {
        found.push({ platform, url: link });
        seenPlatforms.add(platform);
        break;
      }
    }
  }

  return found;
}

// Scrape an artist avatar/profile photo from a platform page
async function scrapeAvatarFromPlatform(platform: string, pageUrl: string): Promise<string | null> {
  const urlCheck = isUrlSafeToFetch(pageUrl);
  if (!urlCheck.safe) {
    console.warn(`[Claim] SSRF blocked avatar fetch: ${pageUrl} — ${urlCheck.reason}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UnstreamBot/1.0; +https://unstream.stream)',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) return null;
    const html = await response.text();

    if (platform === 'bandcamp') {
      // Try band-photo img first (handle src before or after class)
      const bandPhoto = html.match(/<img[^>]*class="[^"]*band-photo[^"]*"[^>]*src="([^"]+)"/i)
        || html.match(/<img[^>]*src="([^"]+)"[^>]*class="[^"]*band-photo[^"]*"/i);
      if (bandPhoto) return bandPhoto[1];
      // Fallback: og:image, but filter out album art
      const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)
        || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
      if (ogImage) {
        const src = ogImage[1];
        // Only use og:image if it's NOT album art (album art URLs contain /img/a)
        if (!src.includes('/img/a')) {
          return src;
        }
      }
      return null;
    }

    if (platform === 'youtube') {
      // YouTube channel pages have og:image with the channel avatar
      const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
      if (ogImage) return ogImage[1];
      // Also try link rel image_src
      const imageSrc = html.match(/<link[^>]*rel="image_src"[^>]*href="([^"]+)"/i);
      if (imageSrc) return imageSrc[1];
      return null;
    }

    if (platform === 'mirlo') {
      // Mirlo artist pages have og:image with the artist photo
      const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)
        || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
      if (ogImage) {
        // Resolve relative URLs against the page URL
        try {
          return new URL(ogImage[1], pageUrl).href;
        } catch {
          return ogImage[1];
        }
      }
      return null;
    }

    // Generic fallback: try og:image
    const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)
      || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
    if (ogImage) {
      try {
        return new URL(ogImage[1], pageUrl).href;
      } catch {
        return ogImage[1];
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string>;
  body: string | null;
}) {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Rate limit: strict tier (scraping endpoint)
  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'strict', CORS_HEADERS);
  if (rl.limited) return rl.response;

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const client = getServiceClient();
  if (!client) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Service not configured' }),
    };
  }

  const authUser = await authenticateRequest(event.headers.authorization || event.headers.Authorization);
  if (!authUser) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Authentication required' }),
    };
  }
  const userId = authUser.userId;

  let body: { action: string; slug?: string; websiteUrl?: string; email?: string; platform?: string; url?: string };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  // --- ACTION: START ---
  // Creates a pending claim with a verification code
  if (body.action === 'start') {
    const { slug, websiteUrl } = body;
    if (!slug || !websiteUrl) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'slug and websiteUrl are required' }),
      };
    }

    // Validate URL and check for SSRF
    const urlSafety = isUrlSafeToFetch(websiteUrl);
    if (!urlSafety.safe) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: urlSafety.reason || 'Invalid website URL' }),
      };
    }

    // Find the artist
    const { data: artist, error: findError } = await client
      .from('artists')
      .select('id, name')
      .eq('slug', slug)
      .single();

    if (findError || !artist) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Artist not found' }),
      };
    }

    // Check if already claimed by someone else
    const { data: existingProfile } = await client
      .from('artist_profiles')
      .select('user_id, verified_at')
      .eq('artist_id', artist.id)
      .single();

    if (existingProfile && existingProfile.verified_at && existingProfile.user_id !== userId) {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'This artist has already been claimed' }),
      };
    }

    // Use the email provided by the frontend, or fall back to the authenticated user's email.
    // The frontend email may be empty if the page reloaded after magic link redirect.
    const email = (body.email || authUser.email || '').toLowerCase().trim();

    const verificationCode = generateVerificationCode();

    // Upsert the profile (allows retrying the claim flow)
    const { error: upsertError } = await client
      .from('artist_profiles')
      .upsert(
        {
          artist_id: artist.id,
          user_id: userId,
          email,
          website_url: websiteUrl,
          verification_code: verificationCode,
          verified_at: null,
        },
        { onConflict: 'artist_id' }
      );

    if (upsertError) {
      console.error('[Claim] Failed to create profile:', upsertError);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Failed to start claim: ${upsertError.message}` }),
      };
    }

    const verifyUrl = `https://unstream.stream/a/${slug}`;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        verificationCode,
        verifyUrl,
        message: `Add a link to ${verifyUrl} on your website, then verify.`,
      }),
    };
  }

  // --- ACTION: VERIFY ---
  // Scrapes the website, looks for the Unstream link, discovers platform links
  if (body.action === 'verify') {
    const { slug } = body;
    if (!slug) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'slug is required' }),
      };
    }

    // Find the pending profile
    const { data: artist } = await client
      .from('artists')
      .select('id, name, image_url')
      .eq('slug', slug)
      .single();

    if (!artist) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Artist not found' }),
      };
    }

    const { data: profile } = await client
      .from('artist_profiles')
      .select('*')
      .eq('artist_id', artist.id)
      .eq('user_id', userId)
      .single();

    if (!profile) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'No pending claim found. Start the claim flow first.' }),
      };
    }

    if (profile.verified_at) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ verified: true, message: 'Already verified' }),
      };
    }

    // Scrape the website
    const scrapeResult = await scrapeWebsite(profile.website_url);

    if (!scrapeResult || scrapeResult.links.length === 0) {
      return {
        statusCode: 422,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          verified: false,
          error: 'Could not load your website. Make sure the URL is correct and publicly accessible.',
        }),
      };
    }

    const { links, html } = scrapeResult;

    // Check that the website actually belongs to this artist
    // The page must reference the artist name in its title, text, or meta tags
    if (!pageReferencesArtist(html, artist.name)) {
      console.log(`[Claim] Website ${profile.website_url} does not reference artist "${artist.name}"`);
      return {
        statusCode: 422,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          verified: false,
          error: `This website doesn't appear to belong to ${artist.name}. The page must mention the artist name in its content, title, or description.`,
        }),
      };
    }

    // Check for Unstream link-back using the DB slug (same one shown to the user in verifyUrl)
    // Note: artistSlug(artist.name) can differ from the DB slug (e.g. apostrophes in names),
    // so we use the DB slug to match exactly what we told the user to link to.
    const hasUnstreamLink = links.some(link => {
      try {
        const url = new URL(link);
        return url.hostname.includes('unstream.stream') &&
          url.pathname.includes(slug);
      } catch {
        return false;
      }
    });

    if (!hasUnstreamLink) {
      return {
        statusCode: 422,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          verified: false,
          error: `We couldn't find a link to unstream.stream on your website. Add a link to https://unstream.stream/a/${slug} and try again.`,
        }),
      };
    }

    // Verification passed! Discover platform links from the website.
    const discoveredLinks = identifyPlatformLinks(links);

    // Mark profile as verified
    await client
      .from('artist_profiles')
      .update({ verified_at: new Date().toISOString() })
      .eq('id', profile.id);

    // Update artist to claimed
    await client
      .from('artists')
      .update({
        match_confidence: 'claimed',
        source: 'claimed',
      })
      .eq('id', artist.id);

    // Add website as officialsite link
    const { data: existingLinks } = await client
      .from('artist_links')
      .select('platform, url')
      .eq('artist_id', artist.id);

    const existingPlatforms = new Set((existingLinks || []).map(l => l.platform));

    if (!existingPlatforms.has('officialsite')) {
      await client.from('artist_links').insert({
        artist_id: artist.id,
        platform: 'officialsite',
        url: profile.website_url,
        source: 'claimed',
        is_direct: true,
      });
    }

    // Upsert discovered platform links (upgrade source to 'claimed')
    for (const link of discoveredLinks) {
      await client.from('artist_links').upsert(
        {
          artist_id: artist.id,
          platform: link.platform,
          url: link.url,
          source: 'claimed',
          is_direct: true,
        },
        { onConflict: 'artist_id,platform' }
      );
    }

    console.log(`[Claim] Verified "${artist.name}" — discovered ${discoveredLinks.length} platform links from website`);

    // Build full link list for the review step (existing + newly discovered, deduplicated)
    const allLinksMap = new Map<string, { platform: string; url: string }>();
    for (const el of (existingLinks || [])) {
      allLinksMap.set(el.platform, { platform: el.platform, url: el.url });
    }
    // Officialsite we just inserted
    allLinksMap.set('officialsite', { platform: 'officialsite', url: profile.website_url });
    for (const dl of discoveredLinks) {
      allLinksMap.set(dl.platform, { platform: dl.platform, url: dl.url });
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        verified: true,
        discoveredLinks: discoveredLinks.length,
        allLinks: Array.from(allLinksMap.values()),
        imageUrl: artist.image_url || null,
        message: `Profile verified! Found ${discoveredLinks.length} platform links on your website.`,
      }),
    };
  }

  // --- ACTION: FETCH-AVATAR ---
  // Scrapes a platform page for an artist profile photo
  if (body.action === 'fetch-avatar') {
    const { platform, url: avatarPageUrl } = body;
    if (!platform || !avatarPageUrl) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'platform and url are required' }),
      };
    }

    const imageUrl = await scrapeAvatarFromPlatform(platform, avatarPageUrl);
    if (!imageUrl) {
      return {
        statusCode: 422,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Could not find a profile photo on that page' }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ imageUrl }),
    };
  }

  return {
    statusCode: 400,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: 'Invalid action. Use "start", "verify", or "fetch-avatar".' }),
  };
}
