// API endpoint: /api/me/buffer — the curator's own Buffer connection
// (docs/specs/curator-posts-spec.md, "Buffer auth").
//
//   GET    /api/me/buffer            is this account connected, and which channels does it have
//   POST   /api/me/buffer/start      begin the OAuth flow; returns the URL to send them to
//   GET    /api/me/buffer/callback   Buffer redirects here; exchanges the code and stores tokens
//   POST   /api/me/buffer/channels   which channels Unstream may post to
//   DELETE /api/me/buffer            disconnect
//
// **The callback carries no Authorization header** — it's a top-level redirect from Buffer, not
// a fetch from our page. So who it belongs to is held server-side against the opaque `state`,
// alongside the PKCE verifier, and both are consumed on first use.

import { getRedis } from './redis';
import { buildCorsHeaders, isUrlHostnameAllowed } from './middleware';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { bufferGraphQL, listChannels } from './buffer-client';
import {
  buildAuthorizeUrl,
  bufferOAuthConfigured,
  createPkcePair,
  exchangeCode,
} from './buffer-oauth';
import {
  BufferNotConnectedError,
  canUseCuratorPosts,
  clearBufferConnection,
  getBufferConnection,
  saveBufferConnection,
  setSelectedChannels,
  usableAccessToken,
} from './buffer-db';
import { Sentry, withSentry } from '../lib/sentry';
import { randomBytes } from 'node:crypto';

/** Long enough to sign in to Buffer and approve, short enough that a leaked state is useless. */
const FLOW_TTL_SECONDS = 600;

const flowKey = (state: string) => `buffer-oauth:${state}`;

/** Where the curator lands after connecting. Same origin, so no open redirect to worry about. */
const RETURN_PATH = '/curator/new';

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string | null;
  path?: string;
  rawUrl?: string;
}

interface PendingFlow { userId: string; verifier: string }

function actionFrom(event: HandlerEvent): string {
  const raw = event.rawUrl
    ? (() => { try { return new URL(event.rawUrl!).pathname; } catch { return event.path ?? ''; } })()
    : (event.path ?? '');
  const last = raw.replace(/\/+$/, '').split('/').pop() ?? '';
  return last === 'buffer' ? '' : last;
}

function siteOrigin(): string {
  return (process.env.URL ?? 'https://unstream.stream').replace(/\/+$/, '');
}

/** Send the curator back to the compose page with a word about how it went. */
function redirectBack(outcome: string) {
  return { statusCode: 302, headers: { Location: `${siteOrigin()}${RETURN_PATH}?buffer=${outcome}` }, body: '' };
}

async function handleRequest(event: HandlerEvent) {
  const CORS_HEADERS: Record<string, string> = buildCorsHeaders(event.headers.origin || event.headers.Origin, false);
  const respond = (statusCode: number, body: unknown) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };

  const action = actionFrom(event);

  if (!bufferOAuthConfigured()) {
    return action === 'callback' ? redirectBack('unavailable') : respond(200, { available: false });
  }

  // --- The callback is the one leg without a bearer token ---------------------------------
  // It has no user to check the gate against, and needs none: it only redeems a `state` that
  // /start minted, and /start is behind the gate below.
  if (action === 'callback') {
    const url = (() => { try { return new URL(event.rawUrl ?? ''); } catch { return null; } })();
    const state = url?.searchParams.get('state') ?? '';
    const code = url?.searchParams.get('code') ?? '';
    const denied = url?.searchParams.get('error');
    if (denied) return redirectBack(denied === 'access_denied' ? 'cancelled' : 'failed');
    if (!state || !code) return redirectBack('failed');

    const redis = getRedis();
    if (!redis) return redirectBack('failed');

    // Consume the flow: read and delete together, so a replayed callback finds nothing.
    const pending = await redis.get<PendingFlow>(flowKey(state));
    await redis.del(flowKey(state));
    if (!pending?.userId || !pending.verifier) return redirectBack('expired');

    try {
      const tokens = await exchangeCode(code, pending.verifier);
      // Which organization these tokens belong to, read once so posting doesn't have to ask.
      await saveBufferConnection(pending.userId, tokens, await organizationFor(tokens.accessToken));
      return redirectBack('connected');
    } catch (error) {
      Sentry.captureException(error, { tags: { buffer: 'oauth-callback' } });
      return redirectBack('failed');
    }
  }

  // --- Everything else is a normal account endpoint ----------------------------------------
  const { key, user } = await resolveAccountRequest(
    event.headers.authorization || event.headers.Authorization || undefined,
    getClientIp(event.headers),
  );
  const rl = await checkRateLimit(key, 'account', CORS_HEADERS);
  if (rl.limited) return rl.response as { statusCode: number; headers: Record<string, string>; body: string };
  if (!user) return respond(401, { error: 'Not signed in' });
  const userId = user.userId;

  // The flag gates the whole feature, connecting included, and fails closed; the admin is let
  // through regardless, to test it before it is switched on.
  if (!(await canUseCuratorPosts(user.email))) return respond(200, { available: false });

  try {
    if (event.httpMethod === 'GET' && action === '') {
      const connection = await getBufferConnection(userId);
      if (!connection) return respond(200, { available: true, connected: false });

      // Channels come from Buffer rather than from us, so a channel they removed there
      // disappears here too.
      const token = await usableAccessToken(userId);
      const channels = await listChannels(token, connection.organizationId ?? '');
      return respond(200, {
        available: true,
        connected: true,
        organizationId: connection.organizationId,
        selectedChannelIds: connection.selectedChannelIds,
        channels: channels
          .filter(c => !c.isDisconnected)
          .map(c => ({
            id: c.id,
            name: c.name,
            service: c.service,
            // Instagram and Facebook are all this posts to; everything else is listed as
            // unsupported rather than hidden, so a curator can see we know it's there.
            supported: c.service === 'instagram' || c.service === 'facebook',
          })),
      });
    }

    if (event.httpMethod === 'POST' && action === 'start') {
      const redis = getRedis();
      if (!redis) return respond(503, { error: 'Cannot start the connection right now' });

      const state = randomBytes(32).toString('base64url');
      const { verifier, challenge } = createPkcePair();
      await redis.set(flowKey(state), { userId, verifier } satisfies PendingFlow, { ex: FLOW_TTL_SECONDS });

      const authorizeUrl = buildAuthorizeUrl(state, challenge);
      if (!isUrlHostnameAllowed(authorizeUrl)) return respond(500, { error: 'Buffer auth host not allowed' });
      return respond(200, { authorizeUrl });
    }

    if (event.httpMethod === 'POST' && action === 'channels') {
      const body = JSON.parse(event.body || '{}') as { channelIds?: unknown };
      const ids = Array.isArray(body.channelIds) ? body.channelIds.filter((id): id is string => typeof id === 'string') : [];
      await setSelectedChannels(userId, ids);
      return respond(200, { selectedChannelIds: ids });
    }

    if (event.httpMethod === 'DELETE' && action === '') {
      // Only our own record goes. Buffer's own revocation lives in their settings, and doing it
      // for them would be a surprise.
      await clearBufferConnection(userId);
      return respond(200, { connected: false });
    }

    return respond(404, { error: 'Unknown action' });
  } catch (error) {
    if (error instanceof BufferNotConnectedError) {
      return respond(200, { available: true, connected: false, reason: error.message });
    }
    Sentry.captureException(error, { tags: { buffer: `me-buffer:${action || 'root'}` } });
    return respond(500, { error: error instanceof Error ? error.message : 'Something went wrong' });
  }
}

/**
 * The organization a freshly issued token belongs to.
 *
 * Read once at connect time and stored, because every later call needs it and asking each time
 * would be a round trip per post. The first organization: Buffer's own UI treats one account as
 * one workspace, and a curator with several can reconnect to change it.
 */
async function organizationFor(accessToken: string): Promise<string | null> {
  const data = await bufferGraphQL<{ account?: { organizations?: { id: string }[] } }>(
    accessToken,
    'query { account { organizations { id } } }',
  );
  return data.account?.organizations?.[0]?.id ?? null;
}

export const handler = withSentry(handleRequest);
