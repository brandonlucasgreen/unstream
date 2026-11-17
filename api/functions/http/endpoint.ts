// The one preamble every JSON endpoint in api/functions/ shares, written once.
//
// An endpoint says what it is in one plain object and supplies a function for the part that is
// actually its own:
//
//   export const handler = withSentry(endpoint({
//     cors: 'account',
//     methods: ['GET', 'POST'],
//     auth: 'account',
//     rateLimit: 'account',
//     jsonBody: true,
//   }, async ({ method, user, body, query }) => {
//     ...
//     return { status: 200, body: { location } };
//   }));
//
// Before this, every handler hand-wrote the preflight, the CORS builder, the auth call, the
// rate-limit call and the JSON parse, and each chose them separately. Two security gaps found on
// 2026-11-16 were exactly that: claim-artist.ts had a private auth function that skipped the
// two-step check, and 20 signed-in endpoints sent a wildcard CORS origin. Here a signed-in
// endpoint cannot be declared with the wildcard at all (see SignedInEndpointOptions), and an
// answer cannot leave without its CORS headers, because every answer leaves through `answer`.
//
// What it does, in order:
//   1. builds the CORS headers for this request
//   2. answers the OPTIONS preflight (204)
//   3. refuses a method the endpoint didn't list (405, with Allow), before spending anything
//   4. authenticates and rate-limits, with the same calls in the same order as the hand-written
//      handlers it replaces (see `auth` below), so it adds no Redis command
//   5. parses the JSON body, when the endpoint takes one (400 on anything but a JSON object)
//   6. calls the endpoint's function and attaches the CORS headers to what it returns
//   7. reports an error the function throws to Sentry and answers 500, still with CORS
//
// It is still exported through `withSentry` in each function file: that is what waits for the
// report in step 7 to be sent before the invocation is torn down, and with-sentry.test.ts
// checks every file for it.
//
// This file sits in a subfolder because Netlify deploys every top-level .ts in api/functions/
// as a function of its own. Never add http/http.ts or http/index.ts: Netlify would deploy the
// folder (endpoint-wrapper-adoption.test.ts checks).
//
// Not every handler is on it yet. endpoint-wrapper-adoption.test.ts lists the ones still to
// move; a new endpoint starts here.

import { Sentry } from '../../lib/sentry';
import { buildAccountCorsHeaders } from '../account-cors';
import {
  SECOND_FACTOR_REQUIRED_ERROR,
  authenticateAdmin,
  buildCorsHeaders,
  buildPublicCorsHeaders,
  sessionMissingSecondFactor,
  type BearerUser,
} from '../middleware';
import { checkRateLimit, getClientIp, resolveAccountRequest, type RateLimitTier } from '../ratelimit';

export type EndpointMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface SharedOptions {
  /** The methods this endpoint serves. OPTIONS is always answered; anything else is a 405. */
  methods: EndpointMethod[];
  /**
   * Whether the endpoint reads a JSON body. When true, the body of every method except GET is
   * parsed before the endpoint's function runs: an empty body is `{}`, and anything that isn't a
   * JSON object is a 400.
   */
  jsonBody: boolean;
}

/**
 * An endpoint anyone may call.
 *
 * `cors`:
 *   'public' — any origin (buildPublicCorsHeaders). Only for read-only public data.
 *   'site'   — unstream.stream only (buildCorsHeaders).
 *
 * Rate-limited by IP, in the tier given.
 */
export interface PublicEndpointOptions extends SharedOptions {
  auth: 'none';
  cors: 'public' | 'site';
  rateLimit: RateLimitTier;
}

/**
 * An endpoint a signed-in person calls with a Bearer token. `user` is never null in its function.
 *
 * `auth`:
 *   'account' — the token is verified locally (resolveAccountRequest, which also names the
 *     rate-limit bucket: the user when the token verifies, the IP when it doesn't). A session
 *     revoked on the server keeps working until its token expires, about an hour. For a fan's
 *     own reads and settings, including everything the Mac app and extension call, which cannot
 *     answer a two-step challenge.
 *   'accountWithSecondStep' — the same, and then a session that still owes its second step is
 *     refused with a 403 (sessionMissingSecondFactor). **Use this for anything that acts as an
 *     artist, moves money or changes the account.**
 *   'admin' — the admin account only, checked against Supabase on every request
 *     (authenticateAdmin, which also refuses a session missing its second step). Not
 *     rate-limited, as no admin endpoint is.
 *
 * `cors`:
 *   'account' — the site and the local dev origins (buildAccountCorsHeaders). Never a wildcard.
 *   'accountAndExtension' — the same plus the browser extension's own origin. Only for an
 *     endpoint the extension's popup calls (account-cors.ts says why).
 *   'site' — unstream.stream only (buildCorsHeaders).
 *
 * There is deliberately no 'public' here: an endpoint that takes a token never answers `*`.
 */
export type SignedInEndpointOptions = SharedOptions & { cors: 'account' | 'accountAndExtension' | 'site' } & (
  | { auth: 'account' | 'accountWithSecondStep'; rateLimit: RateLimitTier }
  | { auth: 'admin' }
);

/** What the endpoint's function is handed. */
export interface PublicRequest {
  method: EndpointMethod;
  /** The query string, `{}` when there is none. */
  query: Record<string, string | undefined>;
  /** The parsed JSON body. `{}` for a GET, an empty body, or an endpoint with `jsonBody: false`. */
  body: Record<string, unknown>;
}

export interface SignedInRequest extends PublicRequest {
  /** Whoever the wrapper authenticated. */
  user: BearerUser;
}

/** What the endpoint's function returns. `body` is sent as JSON; `headers` are added to the CORS ones. */
export interface EndpointResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The request as Netlify hands it over. Only what the wrapper reads. */
export interface EndpointEvent {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  queryStringParameters?: Record<string, string | undefined> | null;
}

export interface EndpointResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type EndpointHandler = (event: EndpointEvent) => Promise<EndpointResponse>;
type PublicRespond = (request: PublicRequest) => Promise<EndpointResult>;
type SignedInRespond = (request: SignedInRequest) => Promise<EndpointResult>;

/** The body of a request, or the 400 to answer instead. */
function parseJsonBody(raw: string | null | undefined): { body: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    return { error: 'Invalid JSON' };
  }
  // `null`, a number, a string or a list is valid JSON and not a body any endpoint reads.
  // Refused here so no function has to find out by reading a field off `null`.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Request body must be a JSON object' };
  }
  return { body: parsed as Record<string, unknown> };
}

export function endpoint(options: PublicEndpointOptions, respond: PublicRespond): EndpointHandler;
export function endpoint(options: SignedInEndpointOptions, respond: SignedInRespond): EndpointHandler;
export function endpoint(
  options: PublicEndpointOptions | SignedInEndpointOptions,
  respond: PublicRespond | SignedInRespond,
): EndpointHandler {
  const allowedMethods = [...options.methods, 'OPTIONS'].join(', ');

  return async (event) => {
    const headers = event.headers ?? {};
    const origin = headers.origin || headers.Origin;

    const corsHeaders =
      options.cors === 'public' ? buildPublicCorsHeaders()
      : options.cors === 'site' ? buildCorsHeaders(origin, false)
      : buildAccountCorsHeaders(origin, allowedMethods, { allowExtensionOrigins: options.cors === 'accountAndExtension' });

    // Every answer leaves through here, so none can miss its CORS headers.
    const answer = (status: number, body: unknown, extraHeaders?: Record<string, string>): EndpointResponse => ({
      statusCode: status,
      headers: { ...corsHeaders, ...extraHeaders },
      body: JSON.stringify(body),
    });

    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: corsHeaders, body: '' };
    }

    const method = options.methods.find((allowed) => allowed === event.httpMethod);
    if (!method) {
      return answer(405, { error: 'Method not allowed' }, { Allow: allowedMethods });
    }

    try {
      const authorization = headers.authorization || headers.Authorization;
      const ip = getClientIp(headers);
      let user: BearerUser | null = null;

      if (options.auth === 'none') {
        const rl = await checkRateLimit(ip, options.rateLimit, corsHeaders);
        if (rl.limited) return rl.response ?? answer(429, { error: 'Too many requests. Please try again later.' });
      } else if (options.auth === 'admin') {
        user = await authenticateAdmin(authorization);
        if (!user) return answer(401, { error: 'Unauthorized' });
      } else {
        // One step names both the caller and the bucket (see resolveAccountRequest), and the
        // limit is checked before the 401 so a flood of bad tokens is still counted.
        const account = await resolveAccountRequest(authorization, ip);
        const rl = await checkRateLimit(account.key, options.rateLimit, corsHeaders);
        if (rl.limited) return rl.response ?? answer(429, { error: 'Too many requests. Please try again later.' });
        if (!account.user) return answer(401, { error: 'Not authenticated' });
        if (options.auth === 'accountWithSecondStep' && (await sessionMissingSecondFactor(authorization))) {
          return answer(403, { error: SECOND_FACTOR_REQUIRED_ERROR });
        }
        user = account.user;
      }

      let body: Record<string, unknown> = {};
      if (options.jsonBody && method !== 'GET') {
        const parsed = parseJsonBody(event.body);
        if ('error' in parsed) return answer(400, { error: parsed.error });
        body = parsed.body;
      }

      const request: PublicRequest = { method, query: event.queryStringParameters ?? {}, body };
      const result = user
        ? await (respond as SignedInRespond)({ ...request, user })
        : await (respond as PublicRespond)(request);
      return answer(result.status, result.body, result.headers);
    } catch (error) {
      // Without this the error would leave as a bare 500 with no CORS headers, which a browser
      // on another origin reports as a network failure with nothing to read.
      Sentry.captureException(error, { extra: { context: 'endpoint', method } });
      return answer(500, { error: 'Internal server error' });
    }
  };
}
