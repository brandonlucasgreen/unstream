// API endpoint: /api/me/feed-token
//
// GET    — the user's feed URLs, creating a token on first ask.
// POST   — rotate: issue a new token, instantly breaking every existing subscription.
// DELETE — revoke entirely.
//
// Follows the same conventions as the other me-* endpoints (bearer auth against the anon
// client, hand-rolled permissive CORS, service-role client for the write). These are the only
// files in api/tsconfig.json's typecheck include — keep this one in it.

import { randomBytes } from 'crypto';
import { deleteFeedToken, getFeedToken, setFeedToken } from './db';
import { checkRateLimit, resolveAccountRequest, getClientIp } from './ratelimit';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

const SITE = 'https://unstream.stream';

/**
 * 32 bytes, base64url — 256 bits of entropy in a 43-character path segment.
 *
 * This is the whole credential for the private feed, and unlike a password it is never rate-
 * limited behind a login form: anyone may request any `/feed/f/{x}.ics`. So it has to be
 * unguessable by brute force outright, not merely hard to guess. base64url because the value
 * goes in a URL path and must survive being copied between a browser, a calendar client's text
 * field, and back.
 *
 * `randomBytes` from node:crypto, not `crypto.subtle`, which isn't available in Netlify
 * Functions.
 */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function feedUrls(token: string) {
  return {
    ics: `${SITE}/feed/f/${token}.ics`,
    atom: `${SITE}/feed/f/${token}.xml`,
  };
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    // The response contains the token, so it must not be cached anywhere shared.
    headers: { ...CORS_HEADERS, 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export async function handler(event: {
  httpMethod: string;
  headers: Record<string, string | undefined>;
}) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // One verification, not two: deriving the rate-limit bucket already checked the token
  // (see resolveAccountRequest), so the user it found is the user this handler uses.
  const { key, user } = await resolveAccountRequest(event.headers.authorization, getClientIp(event.headers));
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response;

  if (!user) return json(401, { error: 'Not signed in' });
  const userId = user.userId;

  if (event.httpMethod === 'GET') {
    // Created on first read rather than at signup: most fans will never subscribe, and a token
    // that exists is a credential that can leak, so it shouldn't be minted speculatively.
    const existing = await getFeedToken(userId);
    if (existing) return json(200, { ...feedUrls(existing), created: false });

    const token = generateToken();
    if (!(await setFeedToken(userId, token))) {
      return json(500, { error: 'Could not create a feed link' });
    }
    return json(200, { ...feedUrls(token), created: true });
  }

  if (event.httpMethod === 'POST') {
    const token = generateToken();
    if (!(await setFeedToken(userId, token))) {
      return json(500, { error: 'Could not rotate the feed link' });
    }
    // Said plainly so the UI can warn before the user does it: rotation is not additive.
    return json(200, { ...feedUrls(token), rotated: true });
  }

  if (event.httpMethod === 'DELETE') {
    if (!(await deleteFeedToken(userId))) {
      return json(500, { error: 'Could not revoke the feed link' });
    }
    return json(200, { revoked: true });
  }

  return json(405, { error: 'Method not allowed' });
}
