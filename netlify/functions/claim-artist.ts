// API endpoint: POST /api/claim
// Handles two actions:
//   action: 'start'  — create a pending claim (requires auth)
//   action: 'verify' — scrape website, verify link-back, discover platform links

import { createClient } from '@supabase/supabase-js';
import { artistSlug, getClient } from './db';

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

// Verify the JWT from the request and return the user ID
async function authenticateRequest(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  // Use anon client to verify the JWT
  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

function generateVerificationCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

interface ScrapeResult {
  links: string[];
  html: string;
}

// Scrape a website and extract all <a href> links + raw HTML
async function scrapeWebsite(websiteUrl: string): Promise<ScrapeResult | null> {
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

  const userId = await authenticateRequest(event.headers.authorization || event.headers.Authorization);
  if (!userId) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Authentication required' }),
    };
  }

  let body: { action: string; slug?: string; websiteUrl?: string; email?: string };
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

    // Validate URL
    try {
      new URL(websiteUrl);
    } catch {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Invalid website URL' }),
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

    // Use the email provided by the frontend (the one the artist signed in with)
    const email = (body.email || '').toLowerCase().trim();

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
      .select('id, name')
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

    // Check for Unstream link-back
    const unstreamSlug = artistSlug(artist.name);
    const hasUnstreamLink = links.some(link => {
      try {
        const url = new URL(link);
        return url.hostname.includes('unstream.stream') &&
          url.pathname.includes(unstreamSlug);
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
      .select('platform')
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

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        verified: true,
        discoveredLinks: discoveredLinks.length,
        message: `Profile verified! Found ${discoveredLinks.length} platform links on your website.`,
      }),
    };
  }

  return {
    statusCode: 400,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: 'Invalid action. Use "start" or "verify".' }),
  };
}
