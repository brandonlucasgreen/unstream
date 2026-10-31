// Buffer's OAuth 2.0 flow, so each curator posts from their own Buffer account
// (docs/specs/curator-posts-spec.md, "Buffer auth").
//
// Authorization Code **with PKCE**, which Buffer requires of every client.
//
// **Unstream is a public client** (Brandon, 2026-10-30): its source is open, and Buffer asks
// open-source apps to register as public, which proves itself with PKCE alone and must **not**
// send a client secret. Whether a secret is sent follows whether BUFFER_CLIENT_SECRET is set, so
// the switch from the old confidential client was a matter of Netlify variables, not a deploy
// timed to the minute. Leave it unset: a public client that sends one is refused.
//
// Three properties of Buffer's tokens drive everything here:
//
//   1. An access token lasts an hour, so a curator who connected yesterday arrives expired.
//      Nothing may use a stored token without checking first.
//   2. A refresh token only exists if `offline_access` was requested. Without it a connection
//      dies after an hour and cannot be revived.
//   3. **Refresh tokens are single-use, and replaying one revokes the entire grant** — the
//      curator is silently disconnected and has to reconnect. So a refresh is a compare-and-set
//      against buffer_connections.refresh_counter: whoever's counter matches spends the token,
//      and anyone else re-reads rather than calling Buffer with a token already spent.

import { createHash, randomBytes } from 'node:crypto';
import { isUrlHostnameAllowed } from './middleware';
import { BufferError } from './buffer-client';

const AUTHORIZE_URL = 'https://auth.buffer.com/auth';
const TOKEN_URL = 'https://auth.buffer.com/token';

/**
 * What Unstream asks for, and no more.
 *
 * `posts:write` creates the posts, `account:read` lists the channels, and `offline_access` is
 * the only reason Buffer issues a refresh token at all — without it a connection stops working
 * an hour after it's made.
 *
 * `posts:read` is for release autopost's analytics (docs/specs/release-autopost-analytics-spec.md),
 * which reads the artist's posts and their numbers. It's asked for now, before that's built,
 * because adding a scope later would send every connected artist back through Buffer's consent
 * screen.
 */
export const BUFFER_SCOPES = ['posts:write', 'posts:read', 'account:read', 'offline_access'];

/** Refresh this far before expiry, so a token can't lapse between the check and the call. */
const REFRESH_SKEW_MS = 60_000;

export interface BufferTokens {
  accessToken: string;
  /** Absent only if Buffer declined offline_access, which would be a misconfiguration. */
  refreshToken: string | null;
  expiresAt: Date;
  /** The scopes Buffer granted, space-separated, when it says: what to check when no refresh token came. */
  scope: string | null;
}

/** Only the client id is needed: a public client has no secret (see the header). */
export function bufferOAuthConfigured(): boolean {
  return !!process.env.BUFFER_CLIENT_ID;
}

/** Where Buffer sends the curator back. Must match a URI registered with the client. */
export function bufferRedirectUri(): string {
  const base = process.env.URL ?? 'https://unstream.stream';
  return `${base.replace(/\/+$/, '')}/api/me/buffer/callback`;
}

// ---------------------------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * base64url of 32 random bytes is 43 characters, inside RFC 7636's 43–128. The verifier stays on
 * the server between the two legs of the flow; only the challenge is ever sent to Buffer.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** The URL to send the curator to. `state` is the caller's CSRF token, checked on return. */
export function buildAuthorizeUrl(state: string, challenge: string): string {
  const clientId = process.env.BUFFER_CLIENT_ID;
  if (!clientId) throw new BufferError(500, 'Buffer OAuth is not configured');

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', bufferRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', BUFFER_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<BufferTokens> {
  const clientId = process.env.BUFFER_CLIENT_ID;
  const clientSecret = process.env.BUFFER_CLIENT_SECRET;
  if (!clientId) throw new BufferError(500, 'Buffer OAuth is not configured');
  if (!isUrlHostnameAllowed(TOKEN_URL)) throw new BufferError(500, 'Buffer auth host not allowed');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // A public client sends no secret; see the header.
    body: new URLSearchParams({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), ...params }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json().catch(() => ({})) as TokenResponse;
  if (!res.ok || json.error || !json.access_token) {
    // invalid_grant on a refresh means the token was already spent or the curator revoked us.
    // Either way the connection is dead and the caller must clear it, not retry.
    const detail = json.error_description || json.error || `Buffer auth ${res.status}`;
    throw new BufferError(res.status === 200 ? 502 : res.status, detail);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    // Buffer gives a lifetime, not a deadline. Treat a missing one as already expired rather
    // than guessing an hour: an over-long guess means calls that fail at Buffer instead of here.
    expiresAt: new Date(Date.now() + (json.expires_in ?? 0) * 1000),
    scope: json.scope ?? null,
  };
}

/** Leg two of the flow: the authorization code for tokens. */
export function exchangeCode(code: string, verifier: string): Promise<BufferTokens> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: bufferRedirectUri(),
    code_verifier: verifier,
  });
}

/**
 * A new access token, and **a new refresh token that replaces the one given**.
 *
 * The caller must store the result before using the access token: Buffer has already retired the
 * old refresh token by the time this returns, so losing the new one costs the curator their
 * connection.
 */
export function refreshTokens(refreshToken: string): Promise<BufferTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Whether a stored token needs refreshing before use. */
export function needsRefresh(expiresAt: Date, now: number = Date.now()): boolean {
  return expiresAt.getTime() - now <= REFRESH_SKEW_MS;
}
