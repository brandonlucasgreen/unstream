// Buffer's OAuth flow: PKCE, the two token legs, and when a stored token is too old to use.
//
// The shapes here come from Buffer's own documentation (developers.buffer.com, read 2026-10-27),
// not from guesswork: PKCE required with S256, an hour-long access token, and a refresh token
// only when offline_access is asked for.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  BUFFER_SCOPES,
  buildAuthorizeUrl,
  bufferOAuthConfigured,
  bufferRedirectUri,
  createPkcePair,
  exchangeCode,
  needsRefresh,
  refreshTokens,
} from '../buffer-oauth';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.BUFFER_CLIENT_ID = 'client-abc';
  process.env.BUFFER_CLIENT_SECRET = 'secret-xyz';
  process.env.URL = 'https://unstream.stream';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BUFFER_CLIENT_ID;
  delete process.env.BUFFER_CLIENT_SECRET;
  delete process.env.URL;
});

describe('configuration', () => {
  it('needs both halves of the client', () => {
    expect(bufferOAuthConfigured()).toBe(true);
    delete process.env.BUFFER_CLIENT_SECRET;
    expect(bufferOAuthConfigured()).toBe(false);
  });

  it('sends the curator back to our own callback', () => {
    expect(bufferRedirectUri()).toBe('https://unstream.stream/api/me/buffer/callback');
  });
});

describe('PKCE', () => {
  it('derives the challenge as the S256 of the verifier, base64url', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('produces a verifier inside RFC 7636’s 43–128 characters, with no padding', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('is different every time', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks Buffer for exactly what the flow needs', () => {
    const url = new URL(buildAuthorizeUrl('state-123', 'challenge-abc'));

    expect(url.origin + url.pathname).toBe('https://auth.buffer.com/auth');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://unstream.stream/api/me/buffer/callback');
  });

  // Without offline_access Buffer issues no refresh token at all, and the connection would die
  // an hour after it was made.
  it('asks for offline_access, and nothing beyond what it uses', () => {
    const scope = new URL(buildAuthorizeUrl('s', 'c')).searchParams.get('scope')!.split(' ');
    expect(scope).toContain('offline_access');
    expect(scope).toEqual(BUFFER_SCOPES);
    expect(scope).not.toContain('account:write');
    expect(scope).not.toContain('posts:read');
  });

  // The secret is what makes us a confidential client; it belongs nowhere near the browser.
  it('never puts the client secret in the URL', () => {
    expect(buildAuthorizeUrl('s', 'c')).not.toContain('secret-xyz');
  });
});

describe('exchangeCode', () => {
  it('sends the code, the verifier and the secret to the token endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }));

    const tokens = await exchangeCode('code-1', 'verifier-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.buffer.com/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('client_secret')).toBe('secret-xyz');
    expect(body.get('redirect_uri')).toBe('https://unstream.stream/api/me/buffer/callback');

    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('carries Buffer’s own reason when it refuses', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code already used' }), { status: 400 }));
    await expect(exchangeCode('code-1', 'v')).rejects.toMatchObject({ name: 'BufferError', message: 'Code already used' });
  });

  // A 200 with an error body is the same trap as the GraphQL API's.
  it('treats a 200 carrying an error as a failure', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_request' }), { status: 200 }));
    await expect(exchangeCode('code-1', 'v')).rejects.toThrow('invalid_request');
  });

  it('refuses to call Buffer with no client configured', async () => {
    delete process.env.BUFFER_CLIENT_ID;
    await expect(exchangeCode('code-1', 'v')).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Rather than guessing an hour, which would mean calls failing at Buffer instead of here.
  it('treats a missing expires_in as already expired', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }));
    const tokens = await exchangeCode('code-1', 'v');
    expect(needsRefresh(tokens.expiresAt)).toBe(true);
  });
});

describe('refreshTokens', () => {
  it('returns the replacement refresh token, which the caller must store', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }), { status: 200 }));

    const tokens = await refreshTokens('rt1');
    const body = new URLSearchParams((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt1');
    expect(tokens.refreshToken).toBe('rt2');
  });

  // Buffer's refresh tokens are single-use; invalid_grant means it was already spent or the
  // curator revoked access. The connection is dead and must be cleared, never retried.
  it('surfaces invalid_grant rather than retrying', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await expect(refreshTokens('rt-old')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('needsRefresh', () => {
  const now = 1_800_000_000_000;

  it('refreshes a token that has already expired', () => {
    expect(needsRefresh(new Date(now - 1), now)).toBe(true);
  });

  // The skew exists so a token can't lapse between the check and the call it was checked for.
  it('refreshes one about to expire, and leaves a fresh one alone', () => {
    expect(needsRefresh(new Date(now + 30_000), now)).toBe(true);
    expect(needsRefresh(new Date(now + 3_600_000), now)).toBe(false);
  });
});
