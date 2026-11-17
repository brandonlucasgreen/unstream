// API endpoint: /api/me/buffer — the user's own Buffer connection, shared by release autopost
// (docs/specs/release-autopost-spec.md) and the paused curator posts (docs/specs/curator-posts-spec.md,
// "Buffer auth").
//
//   GET    /api/me/buffer               is this account connected; its organizations and channels
//   POST   /api/me/buffer/start         begin the OAuth flow; returns the URL to send them to.
//                                        Optional body { returnTo }: the page to come back to
//   GET    /api/me/buffer/callback      Buffer redirects here; exchanges the code and stores tokens
//                                        (its own function, me-buffer-callback.ts: see below)
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
// alongside the PKCE verifier, and both are consumed on first use. That makes it a different
// kind of endpoint from everything else here (public, answers with a redirect), so it is a
// function of its own, me-buffer-callback.ts, routed ahead of this one in netlify.toml. What
// the two share (the pending flow, where a connection may return to) is exported from here.

import { getRedis } from './redis';
import { isUrlHostnameAllowed } from './middleware';
import { endpoint, type SignedInRequest } from './http/endpoint';
import { listChannels, listOrganizations, type BufferChannel } from './buffer-client';
import {
  buildAuthorizeUrl,
  bufferOAuthConfigured,
  createPkcePair,
} from './buffer-oauth';
import {
  BufferNotConnectedError,
  canUseCuratorPosts,
  clearBufferConnection,
  getBufferConnection,
  setOrganization,
  setSelectedChannels,
  usableAccessToken,
} from './buffer-db';
import { canUseReleaseAutopost } from './release-autopost-access';
import { Sentry, withSentry } from '../lib/sentry';
import { randomBytes } from 'node:crypto';

/** Long enough to sign in to Buffer and approve, short enough that a leaked state is useless. */
const FLOW_TTL_SECONDS = 600;

/** Where a pending connection is held in Redis, between /start and the callback. */
export const flowKey = (state: string) => `buffer-oauth:${state}`;

/** Where they land after connecting when the page that started it didn't say. */
export const DEFAULT_RETURN_PATH = '/curator/new';

/**
 * The pages that may start a connection and be returned to: the Promote page's Autopost and
 * Campaigns tabs (either may be where an artist connects Buffer), and curator posts. An allowlist
 * rather than "any path", so a crafted /start can't send someone back to an arbitrary page. Same
 * origin either way, so there is no open redirect.
 */
export function isAllowedReturnPath(path: unknown): path is string {
  return typeof path === 'string'
    && (path === DEFAULT_RETURN_PATH || /^\/promote\/[A-Za-z0-9_-]+(\/campaigns)?$/.test(path));
}

/** What /start keeps for the callback to redeem. */
export interface PendingFlow { userId: string; verifier: string; returnTo?: string }

/** The last path segment after `/buffer`: `start`, `organization`, `channels`, or `''` for the bare path. */
function actionFrom(path: string, rawUrl: string | undefined): string {
  const raw = rawUrl
    ? (() => { try { return new URL(rawUrl).pathname; } catch { return path; } })()
    : path;
  const last = raw.replace(/\/+$/, '').split('/').pop() ?? '';
  return last === 'buffer' ? '' : last;
}

async function handleRequest({ method, user, body, path, rawUrl }: SignedInRequest) {
  const respond = (status: number, answer: unknown) => ({ status, body: answer });
  const action = actionFrom(path, rawUrl);

  if (!bufferOAuthConfigured()) return respond(200, { available: false });

  const userId = user.userId;

  // Connecting is open to anyone either feature lets in. Each flag fails closed, and the admin is
  // let through regardless, to test before it is switched on.
  const allowed = (await canUseReleaseAutopost(user.email)) || (await canUseCuratorPosts(user.email));
  if (!allowed) return respond(200, { available: false });

  try {
    if (method === 'GET' && action === '') {
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

    if (method === 'POST' && action === 'organization') {
      const wanted = typeof body.organizationId === 'string' ? body.organizationId : '';
      // Only one of their own: an id from the browser is checked against what Buffer says
      // this account belongs to.
      const organizations = await listOrganizations(await usableAccessToken(userId));
      if (!organizations.some(o => o.id === wanted)) return respond(400, { error: 'That isn’t one of your Buffer organizations' });
      await setOrganization(userId, wanted);
      return respond(200, { organizationId: wanted, selectedChannelIds: [] });
    }

    if (method === 'POST' && action === 'start') {
      const redis = getRedis();
      if (!redis) return respond(503, { error: 'Cannot start the connection right now' });

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

    if (method === 'POST' && action === 'channels') {
      const connection = await getBufferConnection(userId);
      if (!connection?.organizationId) return respond(409, { error: 'Choose a Buffer organization first' });
      const wanted = Array.isArray(body.channelIds) ? body.channelIds.filter((id): id is string => typeof id === 'string') : [];
      // Only channels this organization has and this feature can post to, so what's stored is
      // always something send can act on.
      const channels = await listChannels(await usableAccessToken(userId), connection.organizationId);
      const allowed = new Set(channels.filter(c => !c.isDisconnected && isSupportedChannel(c)).map(c => c.id));
      const ids = [...new Set(wanted)].filter(id => allowed.has(id));
      await setSelectedChannels(userId, ids);
      return respond(200, { selectedChannelIds: ids });
    }

    if (method === 'DELETE' && action === '') {
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

// Signed in and past the second step: this decides which Buffer account an artist's posts go out
// from. The callback is the one leg that isn't, and it is not this function (see the header).
export const handler = withSentry(endpoint({
  cors: 'site',
  methods: ['GET', 'POST', 'DELETE'],
  auth: 'accountWithSecondStep',
  rateLimit: 'account',
  jsonBody: true,
}, handleRequest));
