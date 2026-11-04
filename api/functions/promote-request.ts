// The checks every Promote endpoint makes before touching an artist: signed in, past the second
// step, rate limited, the feature gate (`canUseReleaseAutopost`), and the artist's own verified
// claim. Used by the asset library (artist-promote-assets.ts) and campaigns
// (artist-campaigns.ts); artist-promote.ts makes the same checks inline, in the same order.

import { buildCorsHeaders, SECOND_FACTOR_REQUIRED_ERROR, sessionMissingSecondFactor } from './middleware';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { canUseReleaseAutopost } from './release-autopost-access';
import { getAutopostArtist, type AutopostArtist } from './release-autopost-db';

export interface PromoteEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
}

export interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type Authorized = {
  artist: AutopostArtist;
  userId: string;
  respond: (statusCode: number, body: unknown) => Response;
};

/** The artist and the respond helper, or the response to send instead. */
export async function authorizePromoteRequest(event: PromoteEvent, methods: string[]): Promise<Authorized | { response: Response }> {
  const headers: Record<string, string> = {
    ...buildCorsHeaders(event.headers.origin || event.headers.Origin, false),
    'Access-Control-Allow-Methods': [...methods, 'OPTIONS'].join(', '),
  };
  const respond = (statusCode: number, body: unknown): Response => ({ statusCode, headers, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { response: { statusCode: 204, headers, body: '' } };
  if (!methods.includes(event.httpMethod)) return { response: respond(405, { error: 'Method not allowed' }) };

  const { key, user } = await resolveAccountRequest(
    event.headers.authorization || event.headers.Authorization || undefined,
    getClientIp(event.headers),
  );
  const rl = await checkRateLimit(key, 'account', headers);
  if (rl.limited) return { response: rl.response as Response };
  if (!user) return { response: respond(401, { error: 'Not signed in' }) };
  // These endpoints act as the artist — they schedule posts from their accounts and settle their
  // Buffer organization — so a half-finished sign-in is refused here as it is on artist-promote.
  const authorization = event.headers.authorization || event.headers.Authorization || undefined;
  if (await sessionMissingSecondFactor(authorization)) return { response: respond(403, { error: SECOND_FACTOR_REQUIRED_ERROR }) };

  // The gate first, so nothing about the feature, or the artist, is said to anyone it excludes.
  if (!(await canUseReleaseAutopost(user.email))) return { response: respond(200, { available: false }) };

  const slug = event.queryStringParameters?.artist;
  if (!slug) return { response: respond(400, { error: 'artist is required' }) };
  const artist = await getAutopostArtist({ slug });
  if (!artist) return { response: respond(404, { error: 'Artist not found' }) };
  if (artist.verifiedOwnerId !== user.userId) return { response: respond(403, { error: 'Only this artist’s verified owner can do this' }) };
  return { artist, userId: user.userId, respond };
}

export function parseBody(event: PromoteEvent): Record<string, unknown> | null {
  try {
    const body = JSON.parse(event.body || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
