// API endpoint: /api/artist-auth
// GET  — returns claimed profiles for the authenticated user
// POST — now a no-op (Supabase handles magic link login directly)

import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';
import { authenticateBearerFast } from './middleware';

function getServiceClient() {
  return getClient();
}

export async function handler(event: { httpMethod: string; headers: Record<string, string | undefined>; body: string | null }) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Rate-limit check (Redis) and token validation (Supabase Auth) are both
  // network round-trips with no data dependency — run them concurrently.
  const ip = getClientIp(event.headers);
  const rlPromise = checkRateLimit(ip, 'standard', headers);
  const userPromise = authenticateBearerFast(event.headers.authorization).catch(() => null);
  const rl = await rlPromise;
  if (rl.limited) return rl.response;

  const client = getServiceClient();
  if (!client) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  // POST: Simplified - Supabase handles magic link login directly
  // This endpoint now just validates that the email format is valid
  if (event.httpMethod === 'POST') {
    try {
      const { email } = JSON.parse(event.body || '{}');
      if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required' }) };
      }

      const normalizedEmail = email.toLowerCase().trim();
      console.log(`[artist-auth] Login request for email: ${normalizedEmail}`);

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(normalizedEmail)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email format' }) };
      }

      // Supabase handles the magic link delivery
      // We just confirm the email is valid and ready to receive a link
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }
  }

  // GET: Return claimed profiles for authenticated user
  if (event.httpMethod === 'GET') {
    const user = await userPromise;
    if (!user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };
    }

    // The artists rows are embedded via the artist_id FK so profiles + artist
    // details arrive in one round-trip instead of two sequential queries.
    const { data: profiles, error } = await client
      .from('artist_profiles')
      .select(`
        id,
        artist_id,
        email,
        bio,
        custom_image_url,
        website_url,
        verified_at,
        claimed_at,
        artists (id, name, slug, image_url)
      `)
      .eq('user_id', user.userId)
      .not('verified_at', 'is', null)
      .order('claimed_at', { ascending: false });

    if (error) {
      console.error('[artist-auth] Error fetching profiles:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch profiles' }) };
    }

    // Backfill: if any profiles have empty email, update with the authenticated user's email.
    // This fixes profiles created when the claim page lost the email on magic link redirect.
    if (user.email && profiles && profiles.length > 0) {
      await Promise.all(profiles.filter(p => !p.email).map(async p => {
        await client
          .from('artist_profiles')
          .update({ email: user.email.toLowerCase().trim() })
          .eq('id', p.id);
        console.log(`[artist-auth] Backfilled email for profile ${p.id}`);
      }));
    }

    const claimedProfiles = (profiles || []).map(p => {
      const artist = (p as { artists?: { name?: string; slug?: string; image_url?: string } }).artists;
      return {
        id: p.id,
        artistId: p.artist_id,
        name: artist?.name || 'Unknown',
        slug: artist?.slug || '',
        imageUrl: p.custom_image_url || artist?.image_url,
        websiteUrl: p.website_url,
        bio: p.bio,
        claimedAt: p.claimed_at,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ profiles: claimedProfiles, email: user.email }),
    };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
}
