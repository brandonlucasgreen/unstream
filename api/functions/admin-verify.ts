// API endpoint: GET/POST /api/admin/verify
// Admin-only endpoint for reviewing artist verification requests.

import { getClient } from './db';
import { authenticateAdmin, buildCorsHeaders } from './middleware';

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: buildCorsHeaders(event.headers['origin'] || event.headers['Origin'], false), body: '' };
  }

  const CORS_HEADERS = buildCorsHeaders(event.headers['origin'] || event.headers['Origin'], false);

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
      .select('id, email, message, status, reviewer_notes, created_at, reviewed_at, artist_id, user_id, artists(name, slug)')
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

    const requests = (data || []).map((r: {
      id: string;
      email: string;
      message: string | null;
      status: string;
      reviewer_notes: string | null;
      created_at: string;
      reviewed_at: string | null;
      artist_id: string;
      user_id: string;
      artists: { name: string; slug: string } | { name: string; slug: string }[] | null;
    }) => {
      const artist = Array.isArray(r.artists) ? r.artists[0] : r.artists;
      return {
        id: r.id,
        artist_name: artist?.name ?? '(unknown)',
        artist_slug: artist?.slug ?? '',
        email: r.email,
        website_url: null,
        message: r.message,
        status: r.status,
        reviewer_notes: r.reviewer_notes,
        created_at: r.created_at,
        reviewed_at: r.reviewed_at,
      };
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ requests }),
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

  if (reviewerNotes && reviewerNotes.length > 2000) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'reviewerNotes must be 2000 characters or fewer' }),
    };
  }

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
    // An artist_profiles row may not exist yet if the user submitted a manual
    // review without first attempting the automated link-back claim flow.
    const { data: existingProfile, error: profileLookupError } = await client
      .from('artist_profiles')
      .select('id')
      .eq('artist_id', request.artist_id)
      .maybeSingle();

    if (profileLookupError) {
      console.error('[Admin] Failed to look up artist profile:', profileLookupError);
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Failed to look up artist profile' }),
      };
    }

    if (existingProfile) {
      const { error: verifyError } = await client
        .from('artist_profiles')
        .update({ verified_at: now })
        .eq('id', existingProfile.id);

      if (verifyError) {
        console.error('[Admin] Failed to verify artist profile:', verifyError);
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Failed to update artist profile' }),
        };
      }
    } else {
      const { error: createError } = await client
        .from('artist_profiles')
        .insert({
          artist_id: request.artist_id,
          user_id: request.user_id,
          email: request.email,
          website_url: null,
          verified_at: now,
        });

      if (createError) {
        console.error('[Admin] Failed to create artist profile:', createError);
        return {
          statusCode: 500,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Failed to create artist profile' }),
        };
      }
    }

    const { error: artistError } = await client
      .from('artists')
      .update({ match_confidence: 'claimed' })
      .eq('id', request.artist_id);

    if (artistError) {
      console.error('[Admin] Failed to update artist match_confidence:', artistError);
      // Non-fatal: the profile is verified even if this fails
    }

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
