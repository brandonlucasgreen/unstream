// API endpoint: /api/me/buffer — the user's own Buffer connection, shared by release autopost
// (docs/specs/release-autopost-spec.md) and the paused curator posts (docs/specs/curator-posts-spec.md,
// "Buffer auth").
//
//   GET    /api/me/buffer               is this account connected; its organizations and channels
//   POST   /api/me/buffer/start         begin the OAuth flow; returns the URL to send them to.
//                                        Optional body { returnTo }: the page to come back to
//   GET    /api/me/buffer/callback      Buffer redirects here; exchanges the code and stores tokens
//   POST   /api/me/buffer/organization  which of their Buffer organizations to post from
//   POST   /api/me/buffer/channels      which channels Unstream may post to
//   DELETE /api/me/buffer               disconnect
//
// **The organization is chosen, never guessed.** A Buffer account can belong to several (its own
// and any it was invited to), and taking the first posted from the wrong one. Connecting keeps it
// only when there is exactly one; otherwise the connection waits with no organization until the
// curator picks, and nothing can post until they do.
//
// **The callback carries no Authorization header** — it's a top-level redirect from Buffer, not
// a fetch from our page. So who it belongs to is held server-side against the opaque `state`,
// alongside the PKCE verifier, and both are consumed on first use.

import { getRedis } from './redis';
import { buildCorsHeaders, isUrlHostnameAllowed } from './middleware';
import { checkRateLimit, getClientIp, resolveAccountRequest } from './ratelimit';
import { listChannels, listOrganizations, type BufferChannel } from './buffer-client';
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
  setOrganization,
  setSelectedChannels,
  usableAccessToken,
} from './buffer-db';
import { canUseReleaseAutopost } from './release-autopost-access';
import { resumeAfterReconnect } from './release-autopost-db';
import { Sentry, withSentry } from '../lib/sentry';
import { randomBytes } from 'node:crypto';

/** Long enough to sign in to Buffer and approve, short enough that a leaked state is useless. */
const FLOW_TTL_SECONDS = 600;

const flowKey = (state: string) => `buffer-oauth:${state}`;

/** Where they land after connecting when the page that started it didn't say. */
const DEFAULT_RETURN_PATH = '/curator/new';

/**
 * The pages that may start a connection and be returned to: release autopost's Promote page, and
 * curator posts. An allowlist rather than "any path", so a crafted /start can't send someone
 * back to an arbitrary page. Same origin either way, so there is no open redirect.
 */
export function isAllowedReturnPath(path: unknown): path is string {
  return typeof path === 'string'
    && (path === DEFAULT_RETURN_PATH || /^\/promote\/[A-Za-z0-9_-]+$/.test(path));
}

interface HandlerEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body?: string | null;
  path?: string;
  rawUrl?: string;
}

interface PendingFlow { userId: string; verifier: string; returnTo?: string }

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

/** Send them back to the page that started it, with a word about how it went. */
function redirectBack(outcome: string, returnTo: string = DEFAULT_RETURN_PATH) {
  const path = isAllowedReturnPath(returnTo) ? returnTo : DEFAULT_RETURN_PATH;
  return { statusCode: 302, headers: { Location: `${siteOrigin()}${path}?buffer=${outcome}` }, body: '' };
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
    if (!state) return redirectBack('failed');

    const redis = getRedis();
    if (!redis) return redirectBack('failed');

    // Consume the flow: read and delete together, so a replayed callback finds nothing. Read even
    // when they declined, to know which page to send them back to.
    const pending = await redis.get<PendingFlow>(flowKey(state));
    await redis.del(flowKey(state));
    const returnTo = pending?.returnTo;
    if (denied) return redirectBack(denied === 'access_denied' ? 'cancelled' : 'failed', returnTo);
    if (!code) return redirectBack('failed', returnTo);
    if (!pending?.userId || !pending.verifier) return redirectBack('expired');

    try {
      const tokens = await exchangeCode(code, pending.verifier);
      // Kept only when there's no choice to make; otherwise the page asks.
      const organizations = await listOrganizations(tokens.accessToken);
      await saveBufferConnection(pending.userId, tokens, organizations.length === 1 ? organizations[0].id : null);
      // Release autopost paused for the lost connection starts again, where it posts from one of
      // this account's organizations. Reported rather than failing the connect: the connection
      // is saved, and the Promote page's Save also resumes.
      try {
        await resumeAfterReconnect(pending.userId, organizations.map(o => o.id));
      } catch (error) {
        Sentry.captureException(error, { tags: { buffer: 'autopost-resume' } });
      }
      return redirectBack('connected', returnTo);
    } catch (error) {
      Sentry.captureException(error, { tags: { buffer: 'oauth-callback' } });
      return redirectBack('failed', returnTo);
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

  // Connecting is open to anyone either feature lets in. Each flag fails closed, and the admin is
  // let through regardless, to test before it is switched on.
  const allowed = (await canUseReleaseAutopost(user.email)) || (await canUseCuratorPosts(user.email));
  if (!allowed) return respond(200, { available: false });

  try {
    if (event.httpMethod === 'GET' && action === '') {
      const connection = await getBufferConnection(userId);
      if (!connection) return respond(200, { available: true, connected: false });

      // Organizations and channels come from Buffer rather than from us, so one they removed
      // there disappears here too.
      const token = await usableAccessToken(userId);
      const organizations = await listOrganizations(token);
      // An organization they've since left reads as none chosen, so the page asks again, and
      // its channels aren't asked for: Buffer would refuse.
      const orgId = organizations.some(o => o.id === connection.organizationId) ? connection.organizationId : null;
      const channels = orgId ? await listChannels(token, orgId) : [];
      const live = channels.filter(c => !c.isDisconnected);
      const liveIds = new Set(live.map(c => c.id));
      return respond(200, {
        available: true,
        connected: true,
        organizations,
        organizationId: orgId,
        // Only ticked channels that still exist: one removed in Buffer can't stay ticked here.
        selectedChannelIds: connection.selectedChannelIds.filter(id => liveIds.has(id)),
        channels: live.map(c => ({
          id: c.id,
          name: c.name,
          service: c.service,
          // Instagram and Facebook are all this posts to; everything else is listed as
          // unsupported rather than hidden, so a curator can see we know it's there.
          supported: isSupportedChannel(c),
        })),
      });
    }

    if (event.httpMethod === 'POST' && action === 'organization') {
      const body = JSON.parse(event.body || '{}') as { organizationId?: unknown };
      const wanted = typeof body.organizationId === 'string' ? body.organizationId : '';
      // Only one of their own: an id from the browser is checked against what Buffer says
      // this account belongs to.
      const organizations = await listOrganizations(await usableAccessToken(userId));
      if (!organizations.some(o => o.id === wanted)) return respond(400, { error: 'That isn’t one of your Buffer organizations' });
      await setOrganization(userId, wanted);
      return respond(200, { organizationId: wanted, selectedChannelIds: [] });
    }

    if (event.httpMethod === 'POST' && action === 'start') {
      const redis = getRedis();
      if (!redis) return respond(503, { error: 'Cannot start the connection right now' });

      const body = JSON.parse(event.body || '{}') as { returnTo?: unknown };
      if (body.returnTo !== undefined && !isAllowedReturnPath(body.returnTo)) {
        return respond(400, { error: 'That page can’t start a Buffer connection' });
      }

      const state = randomBytes(32).toString('base64url');
      const { verifier, challenge } = createPkcePair();
      const flow: PendingFlow = { userId, verifier, ...(body.returnTo ? { returnTo: body.returnTo as string } : {}) };
      await redis.set(flowKey(state), flow, { ex: FLOW_TTL_SECONDS });

      const authorizeUrl = buildAuthorizeUrl(state, challenge);
      if (!isUrlHostnameAllowed(authorizeUrl)) return respond(500, { error: 'Buffer auth host not allowed' });
      return respond(200, { authorizeUrl });
    }

    if (event.httpMethod === 'POST' && action === 'channels') {
      const connection = await getBufferConnection(userId);
      if (!connection?.organizationId) return respond(409, { error: 'Choose a Buffer organization first' });
      const body = JSON.parse(event.body || '{}') as { channelIds?: unknown };
      const wanted = Array.isArray(body.channelIds) ? body.channelIds.filter((id): id is string => typeof id === 'string') : [];
      // Only channels this organization has and this feature can post to, so what's stored is
      // always something send can act on.
      const channels = await listChannels(await usableAccessToken(userId), connection.organizationId);
      const allowed = new Set(channels.filter(c => !c.isDisconnected && isSupportedChannel(c)).map(c => c.id));
      const ids = [...new Set(wanted)].filter(id => allowed.has(id));
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

/** Instagram and Facebook are the networks curator posts are written for (see the spec). */
function isSupportedChannel(channel: BufferChannel): boolean {
  return channel.service === 'instagram' || channel.service === 'facebook';
}

export const handler = withSentry(handleRequest);
