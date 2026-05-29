// API endpoint: /api/artist-auth
// GET  — returns claimed profiles for the authenticated user
// POST — now a no-op (Supabase handles magic link login directly)

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';
import { checkRateLimit, getClientIp } from './ratelimit';

function getServiceClient() {
  return getClient();
}

async function authenticateRequest(authHeader: string | undefined): Promise<{ userId: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    console.log('[artist-auth] Missing or invalid Authorization header');
    return null;
  }
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user) {
    console.log(`[artist-auth] Token validation failed: ${error?.message || 'no user'}`);
    return null;
  }
  return { userId: data.user.id, email: data.user.email || '' };
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

  const ip = getClientIp(event.headers);
  const rl = await checkRateLimit(ip, 'standard', headers);
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
    const user = await authenticateRequest(event.headers.authorization);
    if (!user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };
    }

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
        claimed_at
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
      for (const p of profiles) {
        if (!p.email) {
          await client
            .from('artist_profiles')
            .update({ email: user.email.toLowerCase().trim() })
            .eq('id', p.id);
          console.log(`[artist-auth] Backfilled email for profile ${p.id}`);
        }
      }
    }

    // Fetch artist details for each profile
    const artistIds = (profiles || []).map(p => p.artist_id);
    const { data: artists } = await client
      .from('artists')
      .select('id, name, slug, image_url')
      .in('id', artistIds);

    const artistMap = new Map((artists || []).map(a => [a.id, a]));

    const claimedProfiles = (profiles || []).map(p => {
      const artist = artistMap.get(p.artist_id);
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
