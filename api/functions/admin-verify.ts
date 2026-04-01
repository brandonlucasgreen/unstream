// API endpoint: GET/POST /api/admin/verify
// Admin-only endpoint for reviewing artist verification requests.

import { createClient } from '@supabase/supabase-js';
import { getClient } from './db';

const ADMIN_EMAIL = 'info@kidlightbulbs.com';

async function authenticateAdmin(authHeader: string | undefined): Promise<{ userId: string; email: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const anonClient = createClient(url, anonKey);
  const { data, error } = await anonClient.auth.getUser(token);
  if (error || !data.user || !data.user.email) return null;

  if (data.user.email.toLowerCase() !== ADMIN_EMAIL) return null;

  return { userId: data.user.id, email: data.user.email };
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const admin = await authenticateAdmin(event.headers['authorization'] || event.headers['Authorization'] || undefined);
  if (!admin) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const client = getClient();
  if (!client) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Database not configured' }),
    };
  }

  // GET: List all verification requests (pending first, then past decisions)
  if (event.httpMethod === 'GET') {
    const { data, error } = await client
      .from('verification_requests')
      .select('*')
      .order('status', { ascending: true }) // 'pending' sorts before others alphabetically
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Admin] Failed to fetch verification requests:', error);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to fetch verification requests' }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ requests: data || [] }),
    };
  }

  // POST: Approve or reject a verification request
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body: {
    action?: 'approve' | 'reject';
    requestId?: string;
    reviewerNotes?: string;
  };

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const { action, requestId, reviewerNotes } = body;

  if (!action || !['approve', 'reject'].includes(action)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'action must be "approve" or "reject"' }),
    };
  }

  if (!requestId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'requestId is required' }),
    };
  }

  // Fetch the verification request
  const { data: request, error: fetchError } = await client
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (fetchError || !request) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Verification request not found' }),
    };
  }

  if (request.status !== 'pending') {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Request already ${request.status}` }),
    };
  }

  const now = new Date().toISOString();

  if (action === 'approve') {
    // 1. Find the artist profile associated with this request
    const { data: profile, error: profileError } = await client
      .from('artist_profiles')
      .select('id, artist_id')
      .eq('id', request.artist_profile_id)
      .single();

    if (profileError || !profile) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Artist profile not found for this request' }),
      };
    }

    // 2. Set verified_at on artist_profiles
    const { error: verifyError } = await client
      .from('artist_profiles')
      .update({ verified_at: now })
      .eq('id', profile.id);

    if (verifyError) {
      console.error('[Admin] Failed to verify artist profile:', verifyError);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to update artist profile' }),
      };
    }

    // 3. Update artists table match_confidence to 'claimed'
    const { error: artistError } = await client
      .from('artists')
      .update({ match_confidence: 'claimed' })
      .eq('id', profile.artist_id);

    if (artistError) {
      console.error('[Admin] Failed to update artist match_confidence:', artistError);
      // Non-fatal: the profile is verified even if this fails
    }

    // 4. Update the verification request status
    const { error: updateError } = await client
      .from('verification_requests')
      .update({
        status: 'approved',
        reviewed_at: now,
        reviewer_notes: reviewerNotes || null,
      })
      .eq('id', requestId);

    if (updateError) {
      console.error('[Admin] Failed to update verification request:', updateError);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to update verification request' }),
      };
    }
  } else {
    // Reject: just update the request status
    const { error: updateError } = await client
      .from('verification_requests')
      .update({
        status: 'rejected',
        reviewed_at: now,
        reviewer_notes: reviewerNotes || null,
      })
      .eq('id', requestId);

    if (updateError) {
      console.error('[Admin] Failed to update verification request:', updateError);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to update verification request' }),
      };
    }
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, action, requestId }),
  };
}
