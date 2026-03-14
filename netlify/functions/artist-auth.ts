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
      // Query auth.users directly via service client (bypasses RLS).
      const { data: authUsers, error: authError } = await client
        .from('auth.users' as string)
        .select('id')
        .eq('email', normalizedEmail)
        .limit(1);

      // If direct auth.users query doesn't work (schema access), fall back to admin API
      let matchingUserId: string | null = null;
      if (!authError && authUsers && authUsers.length > 0) {
        console.log(`[artist-auth] Found auth user via direct query: ${authUsers[0].id}`);
        matchingUserId = authUsers[0].id;
      } else {
        if (authError) console.log(`[artist-auth] auth.users query failed (expected if schema not exposed): ${authError.message}`);
        console.log(`[artist-auth] Falling back to admin listUsers API`);
        const url = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_KEY;
        if (url && serviceKey) {
          const adminClient = createClient(url, serviceKey);
          try {
            const { data: userList } = await adminClient.auth.admin.listUsers();
            console.log(`[artist-auth] listUsers returned ${userList?.users?.length ?? 0} users`);
            const matchingUser = userList?.users?.find(
              u => u.email?.toLowerCase() === normalizedEmail
            );
            if (matchingUser) {
              console.log(`[artist-auth] Found auth user via listUsers: ${matchingUser.id}`);
              matchingUserId = matchingUser.id;
            }
          } catch (adminErr) {
            console.error('[artist-auth] Admin listUsers failed:', adminErr);
          }
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
