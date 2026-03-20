// API endpoint: PUT /api/artist-profile
// Authenticated endpoint for updating a claimed artist profile.
// Handles: slug changes, bio updates, platform link edits.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { cacheDeleteByArtist } from './cache';
import { checkRateLimit, getClientIp } from './ratelimit';

function getServiceClient() {
  return getClient();
}

async function authenticateRequest(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'PUT, OPTIONS',
};

interface LinkUpdate {
  platform: string;
  url: string;
  displayName?: string;
}

// Allowed embed domains for featured releases
const ALLOWED_EMBED_DOMAINS = [
  'bandcamp.com',
  'youtube.com',
  'youtube-nocookie.com',
  'soundcloud.com',
  'open.spotify.com',
  'embed.music.apple.com',
  'w.soundcloud.com',
  'player.vimeo.com',
  'embed.tidal.com',
];

function sanitizeEmbed(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;

  // Extract iframe src and validate it's a proper URL
  const iframeMatch = raw.match(/<iframe[^>]*\ssrc=["']([^"']+)["'][^>]*>/i);
  if (!iframeMatch) return null;

  const src = iframeMatch[1];
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(src);
    if (parsedUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  // Validate embed domain against allowlist
  const hostname = parsedUrl.hostname.toLowerCase();
  const domainAllowed = ALLOWED_EMBED_DOMAINS.some(
    d => hostname === d || hostname.endsWith('.' + d)
  );
  if (!domainAllowed) return null;

  // Rebuild iframe with only safe attributes (whitelist approach)
  const safeAttrs: Record<string, string> = { src };

  // Extract safe attributes from original
  const widthMatch = raw.match(/\bwidth=["']([^"']+)["']/i);
  const heightMatch = raw.match(/\bheight=["']([^"']+)["']/i);
  const styleMatch = raw.match(/\bstyle=["']([^"']+)["']/i);
  const allowMatch = raw.match(/\ballow=["']([^"']+)["']/i);
  const allowfullscreen = /\ballowfullscreen\b/i.test(raw);

  if (widthMatch) safeAttrs.width = widthMatch[1];
  if (heightMatch) safeAttrs.height = heightMatch[1];
  if (styleMatch) safeAttrs.style = styleMatch[1];
  if (allowMatch) safeAttrs.allow = allowMatch[1];

  // Build clean iframe from whitelist
  const attrs = Object.entries(safeAttrs)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ');
  const iframe = `<iframe ${attrs}${allowfullscreen ? ' allowfullscreen' : ''} loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`;

  // Cap at 2000 chars
  return iframe.slice(0, 2000);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function handler(event: { httpMethod: string; headers: Record<string, string | undefined>; body: string | null }) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  if (event.httpMethod !== 'PUT') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const client = getServiceClient();
  if (!client) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  const userId = await authenticateRequest(event.headers.authorization || event.headers.Authorization);
  if (!userId) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Authentication required' }) };
  }

  let body: { slug: string; newSlug?: string; newName?: string; bio?: string; featuredEmbed?: string | null; customImageUrl?: string | null; links?: LinkUpdate[] };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { slug } = body;
  if (!slug) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'slug is required' }) };
  }

  // Find the artist and verify ownership
  const { data: artist, error: findError } = await client
    .from('artists')
    .select('id, name, slug')
    .eq('slug', slug)
    .single();

  if (findError || !artist) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artist not found' }) };
  }

  const { data: profile, error: profileError } = await client
    .from('artist_profiles')
    .select('id, user_id, verified_at')
    .eq('artist_id', artist.id)
    .single();

  if (profileError || !profile) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Profile not found' }) };
  }

  if (profile.user_id !== userId) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'You do not own this profile' }) };
  }

  if (!profile.verified_at) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Profile not yet verified' }) };
  }

  // --- Update slug ---
  let finalSlug = slug;
  if (body.newSlug && body.newSlug !== slug) {
    const newSlug = slugify(body.newSlug);
    if (!newSlug || newSlug.length < 2) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Slug must be at least 2 characters' }) };
    }

    // Check if slug is already taken
    const { data: existing } = await client
      .from('artists')
      .select('id')
      .eq('slug', newSlug)
      .neq('id', artist.id)
      .single();

    if (existing) {
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'That URL slug is already taken' }) };
    }

    const { error: slugError } = await client
      .from('artists')
      .update({ slug: newSlug, updated_at: new Date().toISOString() })
      .eq('id', artist.id);

    if (slugError) {
      console.error('[Profile] Slug update failed:', slugError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update slug' }) };
    }

    finalSlug = newSlug;
    console.log(`[Profile] Slug changed: "${slug}" → "${newSlug}" for artist "${artist.name}"`);
  }

  // --- Update name ---
  if (body.newName && body.newName !== artist.name) {
    const newName = body.newName.trim();
    if (!newName || newName.length < 1) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artist name cannot be empty' }) };
    }
    if (newName.length > 100) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Artist name is too long' }) };
    }

    const { error: nameError } = await client
      .from('artists')
      .update({ name: newName, updated_at: new Date().toISOString() })
      .eq('id', artist.id);

    if (nameError) {
      console.error('[Profile] Name update failed:', nameError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update name' }) };
    }
    console.log(`[Profile] Name changed: "${artist.name}" → "${newName}" for slug "${finalSlug}"`);
  }

  // --- Update bio ---
  if (body.bio !== undefined) {
    const bio = body.bio.trim().slice(0, 500) || null;
    const { error: bioError } = await client
      .from('artist_profiles')
      .update({ bio, updated_at: new Date().toISOString() })
      .eq('id', profile.id);

    if (bioError) {
      console.error('[Profile] Bio update failed:', bioError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update bio' }) };
    }
  }

  // --- Update custom image ---
  if (body.customImageUrl !== undefined) {
    let imageUrl: string | null = null;
    if (body.customImageUrl) {
      try {
        const parsed = new URL(body.customImageUrl);
        if (parsed.protocol !== 'https:') {
          return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Image URL must use HTTPS' }) };
        }
        imageUrl = body.customImageUrl;
      } catch {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid image URL' }) };
      }
    }
    const { error: imageError } = await client
      .from('artist_profiles')
      .update({ custom_image_url: imageUrl, updated_at: new Date().toISOString() })
      .eq('id', profile.id);

    if (imageError) {
      console.error('[Profile] Image URL update failed:', imageError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update image' }) };
    }
  }

  // --- Update featured embed ---
  if (body.featuredEmbed !== undefined) {
    const embed = sanitizeEmbed(body.featuredEmbed);
    const { error: embedError } = await client
      .from('artist_profiles')
      .update({ featured_embed: embed, updated_at: new Date().toISOString() })
      .eq('id', profile.id);

    if (embedError) {
      console.error('[Profile] Embed update failed:', embedError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update embed' }) };
    }
  }

  // --- Update links ---
  if (body.links !== undefined) {
    // Delete all existing claimed links for this artist, then re-insert
    // This handles removals, edits, and additions cleanly
    const { error: deleteError } = await client
      .from('artist_links')
      .delete()
      .eq('artist_id', artist.id);

    if (deleteError) {
      console.error('[Profile] Link delete failed:', deleteError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update links' }) };
    }

    // Insert new links
    const validLinks = (body.links || []).filter(l => l.platform && l.url);
    if (validLinks.length > 0) {
      // Assign unique platform IDs for "other" links to satisfy unique(artist_id, platform)
      let otherCount = 0;
      const linksToInsert = validLinks.map((link, index) => {
        const platform = link.platform === 'other' ? `other_${otherCount++}` : link.platform;
        const displayName = link.displayName?.trim().slice(0, 50) || null;
        return {
          artist_id: artist.id,
          platform,
          url: link.url,
          ...(displayName ? { display_name: displayName } : {}),
          source: 'claimed',
          is_direct: true,
          display_order: index,
        };
      });

      const { error: insertError } = await client
        .from('artist_links')
        .insert(linksToInsert);

      if (insertError) {
        console.error('[Profile] Link insert failed:', JSON.stringify(insertError));
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to save links' }) };
      }
    }

    console.log(`[Profile] Updated ${validLinks.length} links for artist "${artist.name}"`);
  }

  // --- Bust caches ---
  // 1. Purge Redis cache for search results containing this artist
  try {
    await cacheDeleteByArtist(artist.name);
  } catch (e) {
    console.error('[Profile] Redis cache purge failed:', e);
  }

  // 2. Purge Netlify CDN cache for this artist's page via cache tag
  try {
    const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteId && token) {
      await fetch(`https://api.netlify.com/api/v1/purge`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          site_id: siteId,
          cache_tags: [`artist-${finalSlug}`],
        }),
      });
      console.log(`[Profile] Purged CDN cache for artist-${finalSlug}`);
    } else {
      console.warn('[Profile] NETLIFY_SITE_ID or NETLIFY_API_TOKEN not set, skipping CDN purge');
    }
  } catch (e) {
    console.error('[Profile] CDN cache purge failed:', e);
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, slug: finalSlug }),
  };
}
