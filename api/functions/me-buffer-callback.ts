// GET /api/me/buffer/callback — where Buffer sends someone back to after they approve (or
// decline) connecting their account. The rest of the Buffer connection is me-buffer.ts, whose
// header describes the whole flow.
//
// **It carries no Authorization header**: it's a top-level redirect from Buffer, not a fetch
// from our page. It has no user to check a gate against, and needs none: it only redeems a
// `state` that /start minted, and /start is signed-in, past the second step and behind the
// feature gates. Who the connection belongs to is held server-side against that opaque `state`,
// alongside the PKCE verifier, and both are consumed on first use.
//
// Every answer is a redirect back into the app with a word about how it went, never JSON: a
// person's browser is what is looking at it.
//
// Routed in netlify.toml ahead of `/api/me/buffer/*`. Its URL is registered with the OAuth
// client, so it has to stay exactly `/api/me/buffer/callback`.

import { getRedis } from './redis';
import { endpoint, type PublicRequest } from './http/endpoint';
import { listOrganizations } from './buffer-client';
import { bufferOAuthConfigured, exchangeCode } from './buffer-oauth';
import { saveBufferConnection } from './buffer-db';
import { DEFAULT_RETURN_PATH, flowKey, isAllowedReturnPath, type PendingFlow } from './me-buffer';
import { resumeAfterReconnect } from './release-autopost-db';
import { Sentry, withSentry } from '../lib/sentry';

function siteOrigin(): string {
  return (process.env.URL ?? 'https://unstream.stream').replace(/\/+$/, '');
}

/** Send them back to the page that started it, with a word about how it went. */
function redirectBack(outcome: string, returnTo: string = DEFAULT_RETURN_PATH) {
  const path = isAllowedReturnPath(returnTo) ? returnTo : DEFAULT_RETURN_PATH;
  return { status: 302, raw: '', headers: { Location: `${siteOrigin()}${path}?buffer=${outcome}` } };
}

async function handleRequest({ rawUrl }: PublicRequest) {
  if (!bufferOAuthConfigured()) return redirectBack('unavailable');

  const url = (() => { try { return new URL(rawUrl ?? ''); } catch { return null; } })();
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
    // Without a refresh token the connection can't outlive this access token: it ends in an
    // hour, whatever happens meanwhile. Said now, with what Buffer granted, rather than only
    // when it dies.
    if (!tokens.refreshToken) {
      Sentry.captureMessage('[buffer] connected without a refresh token: this connection will end within the hour', {
        level: 'error',
        tags: { buffer: 'connect-without-refresh-token' },
        extra: { userId: pending.userId, scope: tokens.scope },
      });
    }
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

// Public, with no CORS (nothing fetches it; a browser navigates to it) and no rate limit: it
// had none before it was split out of me-buffer.ts, and a guessed `state` finds nothing to redeem.
export const handler = withSentry(endpoint({
  cors: 'none',
  methods: ['GET'],
  auth: 'none',
  rateLimit: 'none',
  jsonBody: false,
}, handleRequest));
