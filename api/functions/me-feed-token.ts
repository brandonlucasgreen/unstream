// API endpoint: /api/me/feed-token
//
// GET    — the user's feed URLs, creating a token on first ask.
// POST   — rotate: issue a new token, instantly breaking every existing subscription.
// DELETE — revoke entirely.
//
// An account endpoint like the other me-* ones: the shared wrapper (http/endpoint.ts) answers
// the preflight, signs the caller in and rate-limits; the writes go through the service-role
// client.

import { withSentry } from '../lib/sentry';
import { randomBytes } from 'crypto';
import { deleteFeedToken, getFeedToken, setFeedToken } from './db';
import { endpoint, type EndpointResult, type SignedInRequest } from './http/endpoint';

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

/** The response contains the token, so it must not be cached anywhere shared. */
function json(status: number, body: unknown): EndpointResult {
  return { status, body, headers: { 'Cache-Control': 'private, no-store' } };
}

async function handleRequest({ method, user }: SignedInRequest): Promise<EndpointResult> {
  const userId = user.userId;

  if (method === 'GET') {
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

  if (method === 'POST') {
    const token = generateToken();
    if (!(await setFeedToken(userId, token))) {
      return json(500, { error: 'Could not rotate the feed link' });
    }
    // Said plainly so the UI can warn before the user does it: rotation is not additive.
    return json(200, { ...feedUrls(token), rotated: true });
  }

  // DELETE: the wrapper has already refused every other method.
  if (!(await deleteFeedToken(userId))) {
    return json(500, { error: 'Could not revoke the feed link' });
  }
  return json(200, { revoked: true });
}

export const handler = withSentry(endpoint({
  cors: 'account',
  methods: ['GET', 'POST', 'DELETE'],
  auth: 'account',
  rateLimit: 'account',
  // POST rotates and DELETE revokes; neither reads a body.
  jsonBody: false,
}, handleRequest));
