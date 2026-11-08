// GET /api/me/artist-nav — what the header's artist menu needs: the artists this account has a
// verified claim on, and whether Tips and Promote are open to it.
//
// The menu lists, per artist, Analytics, View page, Edit profile, Releases, Tips and Promote
// (Brandon, 2026-11-08). Tips and Promote are behind flags, and only the server reads flags, so
// their visibility comes from the same gate functions their own endpoints use
// (`tipsOpenToArtist`, `canUseReleaseAutopost`), never from `isAdmin` in the browser.
//
// One request answers the whole menu, and the browser asks once per session
// (apps/web/src/services/artistNav.ts), because the header renders on every page: three
// endpoints per navigation would be three rate-limit commands each time, on a metered Redis.
// Answers 200 with no artists for a signed-in fan, which is nearly everyone.

import { withSentry, Sentry } from '../lib/sentry';
import { getClient } from './db';
import { buildCorsHeaders } from './middleware';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { tipsOpenToArtist } from './tips-db';
import { canUseReleaseAutopost } from './release-autopost-access';

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
}

async function handleRequest(event: HandlerEvent) {
  const CORS_HEADERS = buildCorsHeaders(event.headers.origin || event.headers.Origin, false);
  const respond = (statusCode: number, body: unknown) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return respond(405, { error: 'Method not allowed' });

  const { key, user } = await resolveAccountRequest(
    event.headers.authorization || event.headers.Authorization || undefined,
    getClientIp(event.headers),
  );
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response as { statusCode: number; headers: Record<string, string>; body: string };
  if (!user) return respond(401, { error: 'Not signed in' });

  const client = getClient();
  if (!client) return respond(500, { error: 'Database not configured' });

  try {
    const { data, error } = await client
      .from('artist_profiles')
      .select('verified_at, artists!inner(name, slug)')
      .eq('user_id', user.userId)
      .not('verified_at', 'is', null)
      .order('verified_at', { ascending: true });
    if (error) throw new Error(error.message);

    const artists = ((data ?? []) as Array<{ artists: { name: string; slug: string } | { name: string; slug: string }[] }>)
      .map(row => (Array.isArray(row.artists) ? row.artists[0] : row.artists))
      .filter((artist): artist is { name: string; slug: string } => !!artist?.slug)
      .map(artist => ({ name: artist.name, slug: artist.slug }));

    // A fan with no artist gets no menu, so the flag reads would be wasted on them.
    if (artists.length === 0) return respond(200, { artists, tips: false, promote: false });

    const [tips, promote] = await Promise.all([
      tipsOpenToArtist(user.email),
      canUseReleaseAutopost(user.email),
    ]);
    return respond(200, { artists, tips, promote });
  } catch (err) {
    Sentry.captureException(err, { extra: { context: 'me-artist-nav' } });
    return respond(500, { error: 'Something went wrong' });
  }
}

export const handler = withSentry(handleRequest);
