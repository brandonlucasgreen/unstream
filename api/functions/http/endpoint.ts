// The one preamble every endpoint in api/functions/ shares, written once.
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
//   2. answers the OPTIONS preflight (204), unless the endpoint has no CORS at all
//   3. refuses a method the endpoint didn't list (405, with Allow), before spending anything;
//      HEAD counts as GET
//   4. authenticates and rate-limits, with the calls the hand-written handlers made (see `auth`
//      and `rateLimit` below), so it adds no Redis command
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
// Every function is on it (endpoint-wrapper-adoption.test.ts fails on one that isn't), so a new
// endpoint starts here too.

import { Sentry } from '../../lib/sentry';
import { buildAccountCorsHeaders } from '../account-cors';
import {
  SECOND_FACTOR_REQUIRED_ERROR,
  authenticateAdmin,
  authenticateApiKey,
  authenticateBearer,
  buildCorsHeaders,
  buildPublicCorsHeaders,
  generateRequestId,
  isInternalRequest,
  sessionMissingSecondFactor,
  v1Response,
  type ApiKeyInfo,
  type BearerUser,
} from '../middleware';
import { checkApiRateLimit, checkRateLimit, getClientIp, resolveAccountRequest, type RateLimitTier } from '../ratelimit';

export type EndpointMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One answer for every method, or a function of the method for the few endpoints that differ. */
type PerMethod<T> = T | ((method: EndpointMethod) => T);

/** Limit by the caller's IP before the token is looked at, where the default is the account. */
export interface LimitByIp {
  tier: RateLimitTier;
  by: 'ip';
}

interface SharedOptions {
  /**
   * The methods this endpoint serves. Anything else is a 405. HEAD is never listed: it is
   * answered wherever GET is, by the same function, as a GET (Netlify sends the headers and
   * drops the body). Calendar clients, image fetchers and uptime checks all probe with it.
   */
  methods: EndpointMethod[];
  /**
   * Whether the endpoint reads a JSON body. When true, the body of every method except GET is
   * parsed before the endpoint's function runs: an empty body is `{}`, and anything that isn't
   * a JSON object is a 400.
   */
  jsonBody: boolean;
  /**
   * 'v1' for the documented public API (docs/openapi.yaml): every JSON answer, the wrapper's own
   * refusals included, is wrapped as `{ data, meta }` (v1Response) and carries X-Request-Id.
   */
  envelope?: 'v1';
}

/**
 * An endpoint anyone may call.
 *
 * `cors`:
 *   'public' — any origin (buildPublicCorsHeaders). Only for read-only public data, and the few
 *     write-only beacons the apps and extension send.
 *   'site'   — unstream.stream only (buildCorsHeaders).
 *   'none'   — no CORS headers and no preflight: nothing a browser on another origin calls
 *     (a webhook, a feed, an image, a redirect).
 *
 * `rateLimit`: by IP, in the tier given; 'none' for an answer that costs nothing to produce.
 */
export interface PublicEndpointOptions extends SharedOptions {
  auth: 'none';
  cors: 'public' | 'site' | 'none';
  rateLimit: PerMethod<RateLimitTier | 'none'>;
}

/**
 * An endpoint anyone may call, which also wants to know who is asking when they happen to be
 * signed in (the tip checkout, to credit a tip to the fan's account). `user` is null for
 * everyone else. The token is verified locally, as for 'account'; it decides nothing here, so
 * there is no second-step check.
 *
 * It takes a token, so like every signed-in endpoint it has no 'public' CORS.
 *
 * `rateLimit`: by IP, counted under the `ip:<address>` key the account modes use for a caller
 * with no token. That keeps it out of the budget the public endpoints share under the bare
 * address: a fan who has just run several searches must still be able to start a payment.
 */
export interface OptionalUserEndpointOptions extends SharedOptions {
  auth: 'optional';
  cors: 'site' | 'account' | 'accountAndExtension';
  rateLimit: PerMethod<RateLimitTier | 'none'>;
}

/**
 * An endpoint only our own functions and workflows call, with INTERNAL_FUNCTION_SECRET as the
 * Bearer token (isInternalRequest). No browser calls it, so no CORS, and no rate limit.
 */
export interface InternalEndpointOptions extends SharedOptions {
  auth: 'internal';
  cors: 'none';
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
 *   'bearer' — the token is checked against Supabase on every request (authenticateBearer, which
 *     also refuses a session missing its second step, as a 401). For where a revoked session must
 *     stop working at once: claiming, an artist's profile and releases, payouts, API keys, the
 *     password. Limited by IP, and before the round trip, so a flood never reaches Supabase.
 *   'admin' — the admin account only, checked against Supabase on every request
 *     (authenticateAdmin, which also refuses a session missing its second step). Not
 *     rate-limited, as no admin endpoint is.
 *
 * `rateLimit` for 'account' and 'accountWithSecondStep' is a tier, counted against the account.
 * `{ tier, by: 'ip' }` counts against the IP instead, before the token is read: for a path that
 * checks a credential, where a per-account budget would let more accounts buy more guesses.
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
  | { auth: 'account' | 'accountWithSecondStep'; rateLimit: PerMethod<RateLimitTier | LimitByIp> }
  | { auth: 'bearer'; rateLimit: PerMethod<RateLimitTier | 'none'> }
  | { auth: 'admin' }
);

/**
 * A v1 API endpoint (docs/openapi.yaml). An X-API-Key is optional and picks both answers: with a
 * valid key any origin may call and the key's own quota applies; without one only
 * unstream.stream may, on the anonymous quota (authenticateApiKey, checkApiRateLimit). Every
 * answer after the limit check carries the X-RateLimit-* headers.
 */
export interface ApiKeyEndpointOptions extends SharedOptions {
  auth: 'apiKey';
  cors: 'siteOrApiKey';
  envelope: 'v1';
}

/** What the endpoint's function is handed. */
export interface PublicRequest {
  method: EndpointMethod;
  /** The query string, `{}` when there is none. */
  query: Record<string, string | undefined>;
  /** The parsed JSON body. `{}` for a GET, an empty body, or an endpoint with `jsonBody: false`. */
  body: Record<string, unknown>;
  /** The request's headers, as Netlify hands them over (lower-cased names). */
  headers: Record<string, string | undefined>;
  /** The path the request was made to, e.g. `/api/v1/artist/low`. `''` when Netlify gave none. */
  path: string;
  /** The whole URL, when Netlify gave one. */
  rawUrl: string | undefined;
  /** The body as it was sent, decoded from base64 when Netlify encoded it. For a signature check. */
  rawBody: string;
  /** How long the rate-limit check took, for an endpoint that reports Server-Timing. 0 without one. */
  rateLimitMs: number;
}

export interface SignedInRequest extends PublicRequest {
  /** Whoever the wrapper authenticated. */
  user: BearerUser;
}

export interface OptionalUserRequest extends PublicRequest {
  /** Whoever the request's token belongs to, or null when it carries none that verifies. */
  user: BearerUser | null;
}

export interface ApiKeyRequest extends PublicRequest {
  /** The key the request carried, or null for an anonymous call. */
  apiKey: ApiKeyInfo | null;
}

/**
 * What the endpoint's function returns.
 *
 * Nearly always JSON: `body` is sent as JSON (left out, the answer has no body, for a 204), and
 * `headers` are added to the CORS ones.
 *
 * `raw` is for the few answers that aren't JSON (a feed, an image, a redirect): the string is
 * sent as it is, with `headers` supplying the Content-Type or Location.
 */
export type EndpointResult =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { status: number; raw: string; headers: Record<string, string>; isBase64Encoded?: boolean };

/** The request as Netlify hands it over. Only what the wrapper reads. */
export interface EndpointEvent {
  httpMethod: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  path?: string;
  rawUrl?: string;
}

export interface EndpointResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

type EndpointHandler = (event: EndpointEvent) => Promise<EndpointResponse>;
type PublicRespond = (request: PublicRequest) => Promise<EndpointResult>;
type SignedInRespond = (request: SignedInRequest) => Promise<EndpointResult>;
type OptionalUserRespond = (request: OptionalUserRequest) => Promise<EndpointResult>;
type ApiKeyRespond = (request: ApiKeyRequest) => Promise<EndpointResult>;
type AnyOptions =
  | PublicEndpointOptions
  | OptionalUserEndpointOptions
  | InternalEndpointOptions
  | SignedInEndpointOptions
  | ApiKeyEndpointOptions;
type AnyRespond = PublicRespond | SignedInRespond | OptionalUserRespond | ApiKeyRespond;

const JSON_CONTENT_TYPE = { 'Content-Type': 'application/json' };

/** The body of a request, or the 400 to answer instead. */
function parseJsonBody(raw: string): { body: Record<string, unknown> } | { error: string } {
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

/** The CORS headers for this request, `{}` for an endpoint that has none. */
function corsHeadersFor(options: AnyOptions, origin: string | undefined, allowedMethods: string, hasApiKey: boolean): Record<string, string> {
  // Each builder's own Allow-Methods is a fixed list; the endpoint's real one replaces it.
  const methods = { 'Access-Control-Allow-Methods': allowedMethods };
  switch (options.cors) {
    case 'none': return {};
    case 'public': return { ...buildPublicCorsHeaders(), ...methods };
    case 'site': return buildCorsHeaders(origin, false, methods);
    case 'siteOrApiKey': return buildCorsHeaders(origin, hasApiKey, methods);
    case 'account': return buildAccountCorsHeaders(origin, allowedMethods);
    case 'accountAndExtension': return buildAccountCorsHeaders(origin, allowedMethods, { allowExtensionOrigins: true });
  }
}

export function endpoint(options: PublicEndpointOptions | InternalEndpointOptions, respond: PublicRespond): EndpointHandler;
export function endpoint(options: SignedInEndpointOptions, respond: SignedInRespond): EndpointHandler;
export function endpoint(options: OptionalUserEndpointOptions, respond: OptionalUserRespond): EndpointHandler;
export function endpoint(options: ApiKeyEndpointOptions, respond: ApiKeyRespond): EndpointHandler;
export function endpoint(options: AnyOptions, respond: AnyRespond): EndpointHandler {
  const hasCors = options.cors !== 'none';
  const allowedMethods = (hasCors ? [...options.methods, 'OPTIONS'] : options.methods).join(', ');
  // What a 405 says is allowed: the same, plus the HEAD that every GET also answers.
  const allowHeader = allowedMethods.replace(/\bGET\b/, 'GET, HEAD');

  return async (event) => {
    const headers = event.headers ?? {};
    const origin = headers.origin || headers.Origin;
    const authorization = headers.authorization || headers.Authorization;
    const requestId = options.envelope === 'v1' ? generateRequestId() : null;

    // The v1 API's key decides its CORS answer, so it is read before anything is answered. A
    // request without the header costs nothing here.
    const apiKey = options.auth === 'apiKey'
      ? await authenticateApiKey(headers['x-api-key'] || headers['X-API-Key'])
      : null;

    const baseHeaders: Record<string, string> = {
      ...corsHeadersFor(options, origin, allowedMethods, !!apiKey),
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    };
    let rateLimitInfo: { limit: number; remaining: number; reset: number } | undefined;
    let rateLimitHeaders: Record<string, string> = {};

    // Every JSON answer leaves through here, so none can miss its CORS headers.
    const answer = (status: number, body: unknown, extraHeaders?: Record<string, string>): EndpointResponse => ({
      statusCode: status,
      headers: { ...JSON_CONTENT_TYPE, ...baseHeaders, ...rateLimitHeaders, ...extraHeaders },
      body: body === undefined ? ''
        // A v1 answer names the caller's remaining quota only on a success, as it always has.
        : JSON.stringify(requestId ? v1Response(body, requestId, status === 200 ? rateLimitInfo : undefined) : body),
    });

    if (hasCors && event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: baseHeaders, body: '' };
    }

    const requested = event.httpMethod === 'HEAD' ? 'GET' : event.httpMethod;
    const method = options.methods.find((allowed) => allowed === requested);
    if (!method) {
      return answer(405, { error: 'Method not allowed' }, { Allow: allowHeader });
    }

    try {
      const ip = getClientIp(headers);
      let rateLimitMs = 0;
      /** The 429 to answer, or null when the caller is within the limit. */
      const limit = async (key: string, tier: RateLimitTier): Promise<EndpointResponse | null> => {
        const started = Date.now();
        const rl = await checkRateLimit(key, tier, { ...JSON_CONTENT_TYPE, ...baseHeaders });
        rateLimitMs = Date.now() - started;
        if (!rl.limited) return null;
        return rl.response ?? answer(429, { error: 'Too many requests. Please try again later.' });
      };

      let user: BearerUser | null = null;

      if (options.auth === 'none') {
        const spec = typeof options.rateLimit === 'function' ? options.rateLimit(method) : options.rateLimit;
        const limited = spec === 'none' ? null : await limit(ip, spec);
        if (limited) return limited;
      } else if (options.auth === 'optional') {
        const spec = typeof options.rateLimit === 'function' ? options.rateLimit(method) : options.rateLimit;
        const limited = spec === 'none' ? null : await limit(`ip:${ip}`, spec);
        if (limited) return limited;
        user = (await resolveAccountRequest(authorization, ip)).user;
      } else if (options.auth === 'internal') {
        if (!isInternalRequest(authorization)) return answer(401, { error: 'Unauthorized' });
      } else if (options.auth === 'apiKey') {
        const rl = await checkApiRateLimit(apiKey, ip, { ...JSON_CONTENT_TYPE, ...baseHeaders });
        if (rl.limited) return rl.response ?? answer(429, { error: 'Too many requests. Please try again later.' });
        if (rl.rateLimitInfo) {
          rateLimitInfo = rl.rateLimitInfo;
          rateLimitHeaders = {
            'X-RateLimit-Limit': String(rl.rateLimitInfo.limit),
            'X-RateLimit-Remaining': String(rl.rateLimitInfo.remaining),
            'X-RateLimit-Reset': String(rl.rateLimitInfo.reset),
          };
        }
      } else if (options.auth === 'admin') {
        user = await authenticateAdmin(authorization);
        if (!user) return answer(401, { error: 'Unauthorized' });
      } else if (options.auth === 'bearer') {
        const spec = typeof options.rateLimit === 'function' ? options.rateLimit(method) : options.rateLimit;
        const limited = spec === 'none' ? null : await limit(ip, spec);
        if (limited) return limited;
        user = await authenticateBearer(authorization);
        if (!user) return answer(401, { error: 'Authentication required' });
      } else {
        const spec = typeof options.rateLimit === 'function' ? options.rateLimit(method) : options.rateLimit;
        if (typeof spec === 'object') {
          // By IP, and before the token is read at all (see LimitByIp).
          const limited = await limit(ip, spec.tier);
          if (limited) return limited;
        }
        // One step names both the caller and the bucket (see resolveAccountRequest), and the
        // limit is checked before the 401 so a flood of bad tokens is still counted.
        const account = await resolveAccountRequest(authorization, ip);
        if (typeof spec !== 'object') {
          const limited = await limit(account.key, spec);
          if (limited) return limited;
        }
        if (!account.user) return answer(401, { error: 'Not authenticated' });
        if (options.auth === 'accountWithSecondStep' && (await sessionMissingSecondFactor(authorization))) {
          return answer(403, { error: SECOND_FACTOR_REQUIRED_ERROR });
        }
        user = account.user;
      }

      // Netlify may hand the body over base64-encoded.
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
        : (event.body ?? '');

      let body: Record<string, unknown> = {};
      if (options.jsonBody && method !== 'GET') {
        const parsed = parseJsonBody(rawBody);
        if ('error' in parsed) return answer(400, { error: parsed.error });
        body = parsed.body;
      }

      const request: PublicRequest = {
        method,
        query: event.queryStringParameters ?? {},
        body,
        headers,
        path: event.path ?? '',
        rawUrl: event.rawUrl,
        rawBody,
        rateLimitMs,
      };
      // Each mode has already refused the request above if it had to, so by here `user` is
      // set for every signed-in mode, and null only where the mode allows it.
      const result = options.auth === 'none' || options.auth === 'internal' ? await (respond as PublicRespond)(request)
        : options.auth === 'apiKey' ? await (respond as ApiKeyRespond)({ ...request, apiKey })
        : await (respond as OptionalUserRespond)({ ...request, user });

      if ('raw' in result) {
        return {
          statusCode: result.status,
          headers: { ...baseHeaders, ...rateLimitHeaders, ...result.headers },
          body: result.raw,
          ...(result.isBase64Encoded ? { isBase64Encoded: true } : {}),
        };
      }
      return answer(result.status, result.body, result.headers);
    } catch (error) {
      // Without this the error would leave as a bare 500 with no CORS headers, which a browser
      // on another origin reports as a network failure with nothing to read.
      Sentry.captureException(error, { extra: { context: 'endpoint', method } });
      return answer(500, { error: 'Internal server error' });
    }
  };
}
