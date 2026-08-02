// API endpoint: /api/artist-profile
// Authenticated endpoints for a claimed artist profile.
// PUT    — update the profile: slug changes, bio updates, platform link edits.
// DELETE — remove the claim, handing the page back to its unclaimed state.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getClient, resolveOwnedArtist } from './db';
import { cacheDeleteByArtist } from './cache';
import { checkRateLimit, getClientIp } from './ratelimit';
import { Sentry } from '../lib/sentry';
import { buildLinkRows, DIVIDER_PLATFORM, type LinkEntry } from '../shared/link-dividers';

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
  'Access-Control-Allow-Methods': 'PUT, DELETE, OPTIONS',
};

// Allowed embed domains for featured releases
export const ALLOWED_EMBED_DOMAINS = [
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

export function sanitizeEmbed(raw: string | null, ownedHostnames: string[] = []): string | null {
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

  // Validate embed domain: either a trusted major platform, or a domain the
  // artist already has a verified link to (e.g. a self-hosted Faircamp site,
  // which has no single fixed domain to allowlist).
  const hostname = parsedUrl.hostname.toLowerCase();
  const domainAllowed = ALLOWED_EMBED_DOMAINS.some(
    d => hostname === d || hostname.endsWith('.' + d)
  ) || ownedHostnames.includes(hostname);
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

// Hostnames the artist already has a verified link to, used to allow embeds
// from self-hosted platforms (Faircamp and similar) that have no single
// fixed domain to put in ALLOWED_EMBED_DOMAINS. `bodyLinks` is the editor's
// full desired link list when provided (this save may add the link and embed
// it in the same request); otherwise fall back to what's already stored.
async function getOwnedLinkHostnames(
  client: SupabaseClient,
  artistId: string,
  bodyLinks: LinkEntry[] | undefined
): Promise<string[]> {
  const hostnames = new Set<string>();
  const urls: string[] = [];

  if (bodyLinks) {
    urls.push(...bodyLinks.map(l => l.url).filter((url): url is string => !!url));
  } else {
    const { data: links } = await client
      .from('artist_links')
      .select('url')
      .eq('artist_id', artistId);
    urls.push(...(links || []).map(l => l.url));
  }

  for (const url of urls) {
    try {
      hostnames.add(new URL(url).hostname.toLowerCase());
    } catch {
      // Invalid URLs are rejected elsewhere; just skip for hostname purposes.
    }
  }

  return [...hostnames];
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Search results and the artist's server-rendered page are both cached; anything that changes
// what the page says has to clear them or the edit looks like it didn't save.
async function purgeArtistCaches(artistName: string, slug: string): Promise<void> {
  try {
    await cacheDeleteByArtist(artistName);
  } catch (e) {
    console.error('[Profile] Redis cache purge failed:', e);
  }

  try {
    const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_API_TOKEN;
    if (siteId && token) {
      await fetch('https://api.netlify.com/api/v1/purge', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ site_id: siteId, cache_tags: [`artist-${slug}`] }),
      });
      console.log(`[Profile] Purged CDN cache for artist-${slug}`);
    } else {
      console.warn('[Profile] NETLIFY_SITE_ID or NETLIFY_API_TOKEN not set, skipping CDN purge');
    }
  } catch (e) {
    console.error('[Profile] CDN cache purge failed:', e);
  }
}

// Removing a claim un-verifies the artist rather than deleting them. The artists row is public
// search data that existed before the claim and still describes a real artist; what goes is
// everything the claim added — bio, photo, featured release, divider layout — all of which live
// on the artist_profiles row. Platform links stay: they were discoverable before the claim too.
async function handleRemoveClaim(client: SupabaseClient, slug: string, userId: string) {
  const owned = await resolveOwnedArtist(slug, userId);
  if (!owned.ok || !owned.artistId || !owned.artistName) {
    return { statusCode: owned.status, headers: CORS_HEADERS, body: JSON.stringify({ error: owned.error }) };
  }

  // Scoped to user_id as well as artist_id even though ownership is already proven: this is the
  // one destructive action an artist can take on their own profile, so it shouldn't rely on a
  // check made a few milliseconds earlier.
  const { error: deleteError, count } = await client
    .from('artist_profiles')
    .delete({ count: 'exact' })
    .eq('artist_id', owned.artistId)
    .eq('user_id', userId);

  if (deleteError) {
    console.error('[Profile] Claim removal failed:', deleteError);
    Sentry.captureException(new Error(`artist_profiles delete failed: ${deleteError.message}`), {
      tags: { subsystem: 'artist-profile' },
      extra: { artistId: owned.artistId, slug },
    });
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to remove this artist. Please try again.' }) };
  }

  if (!count) {
    return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'This artist is no longer claimed by your account.' }) };
  }

  // Back to auto-discovered. Left flagged as claimed, the row would never expire and enrichment
  // would keep skipping it (see getArtistBySlug and the enrichment guard in db.ts), so the page
  // would stay frozen on the last edit of an artist who just asked to be removed.
  const { error: revertError } = await client
    .from('artists')
    .update({ match_confidence: 'unverified', source: 'auto', updated_at: new Date().toISOString() })
    .eq('id', owned.artistId);

  if (revertError) {
    // The removal itself stands — the page renders unclaimed with no profile row either way —
    // but the artist row is now in a state only a human can fix, so say so loudly.
    console.error('[Profile] Artist revert after claim removal failed:', revertError);
    Sentry.captureException(new Error(`artist revert after claim removal failed: ${revertError.message}`), {
      tags: { subsystem: 'artist-profile' },
      extra: { artistId: owned.artistId, slug },
    });
  }

  await purgeArtistCaches(owned.artistName, slug);
  console.log(`[Profile] Claim removed for "${owned.artistName}" (${slug})`);

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true }) };
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string> | null;
  body: string | null;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'standard', CORS_HEADERS);
  if (rl.limited) return rl.response;

  if (event.httpMethod !== 'PUT' && event.httpMethod !== 'DELETE') {
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

  // DELETE takes its slug from the query string like the other delete endpoints here — a body
  // on DELETE is inconsistently forwarded, and there's nothing else to send.
  if (event.httpMethod === 'DELETE') {
    const slug = event.queryStringParameters?.slug;
    if (!slug) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'slug is required' }) };
    }
    return handleRemoveClaim(client, slug, userId);
  }

  let body: {
    slug: string;
    newSlug?: string;
    newName?: string;
    bio?: string;
    featuredEmbed?: string | null;
    customImageUrl?: string | null;
    // A `platform: 'divider'` entry is a position marker in the artist's link
    // order, not a link — it carries no URL and is stored on the profile
    // (artist_profiles.link_dividers) rather than as an artist_links row.
    links?: LinkEntry[];
    location?: { city?: string; country?: string };
  };
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

  // --- Update location (city, country) ---
  // Stored on artists (not artist_profiles) so unclaimed artists can also carry
  // enrichment-discovered locations. Artist's answer overrides MB enrichment,
  // so we clear country_code whenever the artist sets country — the alpha-2
  // fallback only makes sense when there's no full country name.
  if (body.location !== undefined) {
    const locationUpdate: { city?: string | null; country?: string | null; country_code?: null; updated_at: string } = {
      updated_at: new Date().toISOString(),
    };
    if (body.location.city !== undefined) {
      const city = body.location.city.trim().slice(0, 100);
      locationUpdate.city = city || null;
    }
    if (body.location.country !== undefined) {
      const country = body.location.country.trim().slice(0, 100);
      locationUpdate.country = country || null;
      locationUpdate.country_code = null;
    }

    const { error: locationError } = await client
      .from('artists')
      .update(locationUpdate)
      .eq('id', artist.id);

    if (locationError) {
      console.error('[Profile] Location update failed:', locationError);
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update location' }) };
    }
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
    let embed: string | null = null;

    // A non-empty value that fails validation is a rejection, not a clear —
    // report it instead of silently saving null under a "success" response
    // (see the featured-embed persistence investigation, 2026-07-31).
    if (body.featuredEmbed && body.featuredEmbed.trim()) {
      const ownedHostnames = await getOwnedLinkHostnames(client, artist.id, body.links);
      embed = sanitizeEmbed(body.featuredEmbed, ownedHostnames);

      if (!embed) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            error: "That embed code isn't supported. Use an embed from Bandcamp, YouTube, Spotify, SoundCloud, Apple Music, Vimeo, Tidal, or a platform you've linked on this profile.",
          }),
        };
      }
    }

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
    // Keep only entries we can actually store, then let buildLinkRows work out
    // the storage shape. The editor sends links and dividers as one ordered
    // list, so the artist's arrangement stays a single source of truth.
    const entries = (body.links || []).filter(l => {
      if (l.platform === DIVIDER_PLATFORM) return true;
      if (!l.platform || !l.url) return false;
      try {
        const parsed = new URL(l.url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    });

    const { links, dividers } = buildLinkRows(entries);

    // One transaction replaces the whole set. This used to be a delete followed
    // by a separate divider update and insert, which meant a failure partway
    // through left the artist with zero links and no way to recover them — see
    // supabase/migrations/20260730013000_atomic-artist-link-replace.sql.
    const { error: replaceError } = await client.rpc('replace_artist_links', {
      p_artist_id: artist.id,
      p_links: links,
      p_dividers: dividers,
    });

    if (replaceError) {
      // Loudly: the artist just tried to save their page and it didn't happen.
      // Nothing was lost (the function rolls back), but we want to know.
      console.error('[Profile] Link replace failed:', JSON.stringify(replaceError));
      Sentry.captureException(new Error(`replace_artist_links failed: ${replaceError.message}`), {
        tags: { subsystem: 'artist-profile' },
        extra: { artistId: artist.id, linkCount: links.length, dividerCount: dividers.length },
      });
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to update links' }) };
    }

    console.log(`[Profile] Updated ${links.length} links and ${dividers.length} dividers for artist "${artist.name}"`);
  }

  await purgeArtistCaches(artist.name, finalSlug);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, slug: finalSlug }),
  };
}
