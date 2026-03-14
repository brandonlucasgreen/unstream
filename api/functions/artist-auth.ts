// API endpoint: /api/artist-auth
// GET  — returns claimed profiles for the authenticated user
// POST — checks if an email has any verified claims (for login gate)

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';

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

  const client = getServiceClient();
  if (!client) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  // POST: Check if email has verified claims (pre-login check, no auth required)
  if (event.httpMethod === 'POST') {
    try {
      const { email } = JSON.parse(event.body || '{}');
      if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required' }) };
      }

      const normalizedEmail = email.toLowerCase().trim();
      console.log(`[artist-auth] Login check for email: ${normalizedEmail}`);

      // Check 1: Direct email match in artist_profiles
      const { data: profiles } = await client
        .from('artist_profiles')
        .select('id')
        .eq('email', normalizedEmail)
        .not('verified_at', 'is', null)
        .limit(1);

      if (profiles && profiles.length > 0) {
        console.log(`[artist-auth] Found profile by email match: ${profiles[0].id}`);
        return { statusCode: 200, headers, body: JSON.stringify({ hasAccount: true }) };
      }

      console.log(`[artist-auth] No direct email match in artist_profiles for: ${normalizedEmail} (found ${profiles?.length ?? 0} rows)`);

      // Check 2: Look up Supabase auth user by email, then check by user_id.
      // This handles profiles where the email wasn't stored (bug: claim page lost
      // email state on magic link redirect, storing '' in the DB).
      // Use GoTrue admin REST API directly with filter param (SDK listUsers doesn't
      // support filtering and only returns the first page of results).
      let matchingUserId: string | null = null;
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_KEY;
      if (supabaseUrl && serviceKey) {
        try {
          const res = await fetch(
            `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(normalizedEmail)}`,
            {
              headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'apikey': serviceKey,
              },
            }
          );
          if (res.ok) {
            const data = await res.json();
            const users = data.users || [];
            console.log(`[artist-auth] GoTrue admin filter returned ${users.length} users`);
            const match = users.find(
              (u: { email?: string }) => u.email?.toLowerCase() === normalizedEmail
            );
            if (match) {
              console.log(`[artist-auth] Found auth user: ${match.id}`);
              matchingUserId = match.id;
            }
          } else {
            console.error(`[artist-auth] GoTrue admin API returned ${res.status}: ${await res.text()}`);
          }
        } catch (err) {
          console.error('[artist-auth] GoTrue admin API call failed:', err);
        }
      }

      if (matchingUserId) {
        console.log(`[artist-auth] Found auth user by email, checking profiles by user_id: ${matchingUserId}`);
        const { data: profilesByUser, error: profileError } = await client
          .from('artist_profiles')
          .select('id, email, verified_at')
          .eq('user_id', matchingUserId)
          .not('verified_at', 'is', null)
          .limit(1);

        console.log(`[artist-auth] Profiles by user_id: ${profilesByUser?.length ?? 0} verified rows${profileError ? `, error: ${profileError.message}` : ''}`);

        if (profilesByUser && profilesByUser.length > 0) {
          // Backfill the missing email so future logins work directly
          if (!profilesByUser[0].email) {
            await client
              .from('artist_profiles')
              .update({ email: normalizedEmail })
              .eq('id', profilesByUser[0].id);
            console.log(`[artist-auth] Backfilled email for profile ${profilesByUser[0].id} via user_id lookup`);
          }
          return { statusCode: 200, headers, body: JSON.stringify({ hasAccount: true }) };
        }

        // Debug: check if profile exists but without verified_at
        const { data: allProfilesByUser } = await client
          .from('artist_profiles')
          .select('id, email, verified_at, user_id')
          .eq('user_id', matchingUserId);
        if (allProfilesByUser && allProfilesByUser.length > 0) {
          console.log(`[artist-auth] Found ${allProfilesByUser.length} total profiles (including unverified) for user_id ${matchingUserId}:`,
            allProfilesByUser.map(p => ({ id: p.id, email: p.email, verified_at: p.verified_at }))
          );
        }
      } else {
        console.log(`[artist-auth] No auth user found for email: ${normalizedEmail}`);
      }

      console.log(`[artist-auth] No verified profiles found for: ${normalizedEmail}`);
      return { statusCode: 200, headers, body: JSON.stringify({ hasAccount: false }) };
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
        imageUrl: artist?.image_url || p.custom_image_url,
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
