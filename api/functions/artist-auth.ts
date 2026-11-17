// API endpoint: /api/artist-auth
// GET — returns claimed profiles for the authenticated user

import { withSentry } from '../lib/sentry';
import { getClient } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

function getServiceClient() {
  return getClient();
}

async function handleRequest({ user }: SignedInRequest): Promise<EndpointResult> {
  const client = getServiceClient();
  if (!client) {
    return { status: 500, body: { error: 'Database not configured' } };
  }

  // GET: Return claimed profiles for authenticated user

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
    return { status: 500, body: { error: 'Failed to fetch profiles' } };
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
    status: 200,
    body: { profiles: claimedProfiles, email: user.email },
  };
}

export const handler = withSentry(endpoint({
  cors: 'account',
  methods: ['GET'],
  auth: 'account',
  rateLimit: { tier: 'standard', by: 'ip' },
  jsonBody: false,
}, handleRequest));
