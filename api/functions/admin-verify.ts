// API endpoint: GET/POST /api/admin/verify
// Admin-only endpoint for reviewing artist verification requests.

import { getClient } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';
import { Sentry, withSentry } from '../lib/sentry';
import { sendNotificationOnce } from './notifications';
import { escapeHtml } from '../shared/html';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleRequest({ method, user: admin, body: parsedBody }: SignedInRequest): Promise<EndpointResult> {
  const client = getClient();
  if (!client) {
    return {
      status: 500,
      body: { error: 'Database not configured' },
    };
  }

  // GET: List all verification requests (pending first, then past decisions)
  if (method === 'GET') {
    const { data, error } = await client
      .from('verification_requests')
      .select(`
        id, email, message, status, reviewer_notes, created_at, reviewed_at,
        artist_id, user_id,
        artists(name, slug)
      `)
      .order('status', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Admin] Failed to fetch verification requests:', error);
      return {
        status: 500,
        body: { error: 'Failed to fetch verification requests' },
      };
    }

    // Fetch artist_profiles separately — no FK between verification_requests
    // and artist_profiles, so PostgREST can't embed them.
    const artistIds = (data || []).map((r: { artist_id: string }) => r.artist_id);
    const profileMap = new Map<string, { verified_at: string | null; user_id: string; website_url: string | null }>();

    if (artistIds.length > 0) {
      const { data: profiles, error: profileError } = await client
        .from('artist_profiles')
        .select('artist_id, verified_at, user_id, website_url')
        .in('artist_id', artistIds);

      if (profileError) {
        console.error('[Admin] Failed to fetch artist profiles:', profileError);
        return {
          status: 500,
          body: { error: 'Failed to fetch artist profiles' },
        };
      }

      for (const p of (profiles || []) as { artist_id: string; verified_at: string | null; user_id: string; website_url: string | null }[]) {
        profileMap.set(p.artist_id, p);
      }
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
      const profile = profileMap.get(r.artist_id);
      return {
        id: r.id,
        artist_name: artist?.name ?? '(unknown)',
        artist_slug: artist?.slug ?? '',
        email: r.email,
        // The site the requester verified with, so the reviewer can check it's the artist's.
        // Only when the profile row is theirs: it may hold someone else's claim in progress.
        website_url: profile?.user_id === r.user_id ? profile.website_url : null,
        message: r.message,
        status: r.status,
        reviewer_notes: r.reviewer_notes,
        created_at: r.created_at,
        reviewed_at: r.reviewed_at,
        link_back_completed: !!profile?.verified_at,
      };
    });

    return {
      status: 200,
      body: { requests },
    };
  }

  // POST: Approve or reject a verification request. The wrapper has already refused every
  // other method.
  const { action, requestId, reviewerNotes, ownershipVerified } = parsedBody as {
    action?: 'approve' | 'reject';
    requestId?: string;
    reviewerNotes?: string;
    ownershipVerified?: boolean;
  };

  if (reviewerNotes && reviewerNotes.length > 2000) {
    return {
      status: 400,
      body: { error: 'reviewerNotes must be 2000 characters or fewer' },
    };
  }

  if (!action || !['approve', 'reject'].includes(action)) {
    return {
      status: 400,
      body: { error: 'action must be "approve" or "reject"' },
    };
  }

  if (!requestId) {
    return {
      status: 400,
      body: { error: 'requestId is required' },
    };
  }

  if (!UUID_REGEX.test(requestId)) {
    return {
      status: 400,
      body: { error: 'requestId must be a UUID' },
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
      status: 404,
      body: { error: 'Verification request not found' },
    };
  }

  if (request.status !== 'pending') {
    return {
      status: 400,
      body: { error: `Request already ${request.status}` },
    };
  }

  // Needed for the decision email below regardless of outcome.
  const { data: artistInfo } = await client
    .from('artists')
    .select('name, slug')
    .eq('id', request.artist_id)
    .single();
  const artistName = artistInfo?.name || 'your artist profile';

  const now = new Date().toISOString();

  if (action === 'approve') {
    // Security gate: admin must explicitly confirm they verified ownership.
    if (!ownershipVerified) {
      return {
        status: 400,
        body: { error: 'Approval requires ownership verification' },
      };
    }

    // An artist_profiles row may not exist yet if the user submitted a manual
    // review without first attempting the automated link-back claim flow.
    // Re-check ownership hasn't changed since the request was submitted.
    const { data: existingProfile, error: profileLookupError } = await client
      .from('artist_profiles')
      .select('id, user_id, verified_at')
      .eq('artist_id', request.artist_id)
      .maybeSingle();

    if (profileLookupError) {
      console.error('[Admin] Failed to look up artist profile:', profileLookupError);
      return {
        status: 500,
        body: { error: 'Failed to look up artist profile' },
      };
    }

    if (existingProfile?.verified_at && existingProfile.user_id !== request.user_id) {
      return {
        status: 409,
        body: { error: 'Artist was claimed by another user while this request was pending' },
      };
    }

    if (existingProfile) {
      // The unverified row may be someone else's claim in progress (one row per artist).
      // Approving this request verifies *this* requester, so hand the row to them; setting
      // verified_at alone would have verified whoever started the other claim.
      const { error: verifyError } = await client
        .from('artist_profiles')
        .update({ verified_at: now, user_id: request.user_id, email: request.email })
        .eq('id', existingProfile.id);

      if (verifyError) {
        console.error('[Admin] Failed to verify artist profile:', verifyError);
        return {
          status: 500,
          body: { error: 'Failed to update artist profile' },
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
          status: 500,
          body: { error: 'Failed to create artist profile' },
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
        ownership_verified_by: admin.userId,
        ownership_verified_at: now,
      })
      .eq('id', requestId);

    if (updateError) {
      console.error('[Admin] Failed to update verification request:', updateError);
      return {
        status: 500,
        body: { error: 'Failed to update verification request' },
      };
    }

    Sentry.captureMessage('Verification request approved', {
      level: 'info',
      extra: {
        requestId,
        artistId: request.artist_id,
        adminId: admin.userId,
      },
    });

    const profileUrl = artistInfo?.slug ? `https://unstream.stream/a/${artistInfo.slug}` : 'https://unstream.stream';
    void sendNotificationOnce({
      client,
      notificationType: 'claim_approved_manual',
      referenceId: requestId,
      recipientEmail: request.email,
      subject: `Your claim of ${artistName} on Unstream is approved`,
      html: `<p>Your claim of <strong>${escapeHtml(artistName)}</strong> on Unstream has been reviewed and approved — your profile is now live at <a href="${profileUrl}">${profileUrl}</a>.</p><p>You can edit your bio, photo, and links any time from your dashboard.</p>`,
      text: `Your claim of ${artistName} on Unstream has been reviewed and approved — your profile is now live at ${profileUrl}.\n\nYou can edit your bio, photo, and links any time from your dashboard.`,
    });
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
        status: 500,
        body: { error: 'Failed to update verification request' },
      };
    }

    void sendNotificationOnce({
      client,
      notificationType: 'claim_rejected',
      referenceId: requestId,
      recipientEmail: request.email,
      subject: `Your claim of ${artistName} on Unstream wasn't approved`,
      html: `<p>Your claim of <strong>${escapeHtml(artistName)}</strong> on Unstream wasn't approved this time.${reviewerNotes ? ` The reviewer left this note: "${escapeHtml(reviewerNotes)}"` : ''}</p><p>If you think this was a mistake, reply to this email and we'll take another look.</p>`,
      text: `Your claim of ${artistName} on Unstream wasn't approved this time.${reviewerNotes ? ` The reviewer left this note: "${reviewerNotes}"` : ''}\n\nIf you think this was a mistake, reply to this email and we'll take another look.`,
    });
  }

  return {
    status: 200,
    body: { success: true, action, requestId },
  };
}

export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['GET', 'POST'],
  auth: 'admin',
  jsonBody: true,
}, handleRequest));
