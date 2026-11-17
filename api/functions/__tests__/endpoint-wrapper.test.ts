// The shared endpoint wrapper (api/functions/http/endpoint.ts). Locked here: every answer carries
// the CORS headers of the shape the endpoint declared, including the refusals the wrapper writes
// itself and the rate limiter's; each auth mode calls the existing auth function it stands for
// and nothing else; and it costs exactly the rate-limit calls the hand-written handlers made.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  resolveAccountRequest: vi.fn(),
  authenticateAdmin: vi.fn(),
  authenticateBearer: vi.fn(),
  authenticateApiKey: vi.fn(),
  isInternalRequest: vi.fn(),
  checkApiRateLimit: vi.fn(),
  sessionMissingSecondFactor: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  checkApiRateLimit: mocks.checkApiRateLimit,
  resolveAccountRequest: mocks.resolveAccountRequest,
  getClientIp: () => '203.0.113.7',
}));
vi.mock('../middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateAdmin: mocks.authenticateAdmin,
  authenticateBearer: mocks.authenticateBearer,
  authenticateApiKey: mocks.authenticateApiKey,
  isInternalRequest: mocks.isInternalRequest,
  sessionMissingSecondFactor: mocks.sessionMissingSecondFactor,
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException },
}));

import {
  endpoint,
  type ApiKeyEndpointOptions,
  type ApiKeyRequest,
  type EndpointEvent,
  type InternalEndpointOptions,
  type PublicEndpointOptions,
  type PublicRequest,
  type SignedInEndpointOptions,
  type SignedInRequest,
} from '../http/endpoint';
import { SECOND_FACTOR_REQUIRED_ERROR } from '../middleware';

const SITE = 'https://unstream.stream';
const FOREIGN = 'https://evil.example';
const LOCAL_DEV = 'http://localhost:8888';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const FAN = { userId: 'user-1', email: 'fan@example.com' };
const ADMIN = { userId: 'admin-1', email: 'admin@example.com' };

const ACCOUNT: SignedInEndpointOptions = {
  cors: 'account',
  methods: ['GET', 'POST'],
  auth: 'account',
  rateLimit: 'account',
  jsonBody: true,
};
const PUBLIC: PublicEndpointOptions = {
  cors: 'public',
  methods: ['GET'],
  auth: 'none',
  rateLimit: 'lenient',
  jsonBody: false,
};
const BEARER: SignedInEndpointOptions = {
  cors: 'account',
  methods: ['GET', 'POST'],
  auth: 'bearer',
  rateLimit: 'standard',
  jsonBody: true,
};
const INTERNAL: InternalEndpointOptions = {
  cors: 'none',
  methods: ['POST'],
  auth: 'internal',
  jsonBody: true,
};
const V1: ApiKeyEndpointOptions = {
  cors: 'siteOrApiKey',
  methods: ['GET'],
  auth: 'apiKey',
  envelope: 'v1',
  jsonBody: false,
};
const API_KEY = { id: 'key-1', keyPrefix: 'uns_abc', tier: 'free' as const, dailyLimit: 100, perMinute: 30, ownerEmail: 'dev@example.com' };
const QUOTA = { limit: 30, remaining: 29, reset: 1790000000 };

/** An endpoint function that records what it was handed and answers 200. */
function recorder<Request>() {
  const calls: Request[] = [];
  const respond = async (request: Request) => {
    calls.push(request);
    return { status: 200, body: { ok: true } };
  };
  return { calls, respond };
}

function event(overrides: Partial<EndpointEvent> = {}): EndpointEvent {
  return { httpMethod: 'GET', headers: { authorization: 'Bearer token', origin: LOCAL_DEV }, body: null, ...overrides };
}

const originOf = (response: { headers: Record<string, string> }) => response.headers['Access-Control-Allow-Origin'];
const errorOf = (response: { body: string }) => JSON.parse(response.body).error;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ limited: false });
  mocks.resolveAccountRequest.mockResolvedValue({ key: 'user:user-1', user: FAN });
  mocks.authenticateAdmin.mockResolvedValue(ADMIN);
  mocks.authenticateBearer.mockResolvedValue(FAN);
  mocks.authenticateApiKey.mockResolvedValue(null);
  mocks.isInternalRequest.mockReturnValue(true);
  mocks.checkApiRateLimit.mockResolvedValue({ limited: false, rateLimitInfo: QUOTA });
  mocks.sessionMissingSecondFactor.mockResolvedValue(false);
});

describe('CORS shapes', () => {
  it("'account' echoes an allowlisted origin and never a foreign one or a wildcard", async () => {
    const handler = endpoint(ACCOUNT, recorder<SignedInRequest>().respond);

    expect(originOf(await handler(event()))).toBe(LOCAL_DEV);
    expect(originOf(await handler(event({ headers: { authorization: 'Bearer token', origin: FOREIGN } })))).toBe(SITE);
    expect(originOf(await handler(event({ headers: { authorization: 'Bearer token', origin: EXTENSION } })))).toBe(SITE);
    expect(originOf(await handler(event({ headers: { authorization: 'Bearer token' } })))).toBe(SITE);
  });

  it("'account' allows exactly the methods the endpoint listed, plus OPTIONS", async () => {
    const response = await endpoint(ACCOUNT, recorder<SignedInRequest>().respond)(event({ httpMethod: 'OPTIONS' }));
    expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    expect(response.headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
  });

  it("'accountAndExtension' also echoes the browser extension's own origin", async () => {
    const handler = endpoint({ ...ACCOUNT, cors: 'accountAndExtension' }, recorder<SignedInRequest>().respond);

    expect(originOf(await handler(event({ headers: { authorization: 'Bearer token', origin: EXTENSION } })))).toBe(EXTENSION);
    expect(originOf(await handler(event({ headers: { authorization: 'Bearer token', origin: FOREIGN } })))).toBe(SITE);
  });

  it("'site' answers unstream.stream whatever the origin", async () => {
    const handler = endpoint({ ...ACCOUNT, cors: 'site' }, recorder<SignedInRequest>().respond);

    expect(originOf(await handler(event()))).toBe(SITE);
    expect(originOf(await handler(event({ headers: { authorization: 'Bearer token', origin: FOREIGN } })))).toBe(SITE);
  });

  it("'public' answers any origin", async () => {
    const response = await endpoint(PUBLIC, recorder<PublicRequest>().respond)(event({ headers: { origin: FOREIGN } }));
    expect(originOf(response)).toBe('*');
  });

  it('reads the Origin header in either case', async () => {
    const response = await endpoint(ACCOUNT, recorder<SignedInRequest>().respond)(
      event({ headers: { authorization: 'Bearer token', Origin: LOCAL_DEV } }),
    );
    expect(originOf(response)).toBe(LOCAL_DEV);
  });
});

describe('preflight and methods', () => {
  it('answers OPTIONS with 204 and the CORS headers, before auth or the rate limit', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event({ httpMethod: 'OPTIONS' }));

    expect(response).toEqual({ statusCode: 204, headers: expect.objectContaining({ 'Access-Control-Allow-Origin': LOCAL_DEV }), body: '' });
    expect(mocks.resolveAccountRequest).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('refuses a method the endpoint did not list with 405, Allow and CORS, spending nothing', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event({ httpMethod: 'DELETE' }));

    expect(response.statusCode).toBe(405);
    expect(errorOf(response)).toBe('Method not allowed');
    expect(response.headers.Allow).toBe('GET, HEAD, POST, OPTIONS');
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(mocks.resolveAccountRequest).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('tells the function which method it is answering', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    await endpoint(ACCOUNT, respond)(event({ httpMethod: 'POST', body: '{}' }));
    expect(calls[0].method).toBe('POST');
  });
});

describe("auth: 'none'", () => {
  it('rate-limits by IP in the tier given, once, and hands the function no user', async () => {
    const { calls, respond } = recorder<PublicRequest>();
    const response = await endpoint(PUBLIC, respond)(event({ headers: {}, queryStringParameters: { query: 'argent' } }));

    expect(response.statusCode).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('203.0.113.7', 'lenient', expect.objectContaining({ 'Access-Control-Allow-Origin': '*' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', query: { query: 'argent' }, body: {} });
    expect(calls[0]).not.toHaveProperty('user');
    // No token is ever looked at on a public endpoint.
    expect(mocks.resolveAccountRequest).not.toHaveBeenCalled();
    expect(mocks.authenticateAdmin).not.toHaveBeenCalled();
  });

  it('answers a request that arrives with no headers or query at all', async () => {
    const { calls, respond } = recorder<PublicRequest>();
    const response = await endpoint(PUBLIC, respond)({ httpMethod: 'GET' });

    expect(response.statusCode).toBe(200);
    expect(calls[0].query).toEqual({});
  });
});

describe("auth: 'account'", () => {
  it('resolves the caller and the bucket in one step, then limits by that bucket', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event());

    expect(response.statusCode).toBe(200);
    expect(mocks.resolveAccountRequest).toHaveBeenCalledTimes(1);
    expect(mocks.resolveAccountRequest).toHaveBeenCalledWith('Bearer token', '203.0.113.7');
    // One rate-limit call per request, in the tier given: the Redis cost of the handlers it replaced.
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('user:user-1', 'account', expect.objectContaining({ 'Access-Control-Allow-Origin': LOCAL_DEV }));
    expect(calls[0].user).toEqual(FAN);
  });

  it('answers 401 with CORS when the token does not verify, after counting the request', async () => {
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'ip:203.0.113.7', user: null });
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event());

    expect(response.statusCode).toBe(401);
    expect(errorOf(response)).toBe('Not authenticated');
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('ip:203.0.113.7', 'account', expect.anything());
    expect(calls).toEqual([]);
  });

  it('reads the Authorization header in either case', async () => {
    await endpoint(ACCOUNT, recorder<SignedInRequest>().respond)(event({ headers: { Authorization: 'Bearer capital' } }));
    expect(mocks.resolveAccountRequest).toHaveBeenCalledWith('Bearer capital', '203.0.113.7');
  });

  it('does not ask about the second step: the apps that call these cannot answer one', async () => {
    await endpoint(ACCOUNT, recorder<SignedInRequest>().respond)(event());
    expect(mocks.sessionMissingSecondFactor).not.toHaveBeenCalled();
  });

  it('never consults the admin check', async () => {
    await endpoint(ACCOUNT, recorder<SignedInRequest>().respond)(event());
    expect(mocks.authenticateAdmin).not.toHaveBeenCalled();
  });
});

describe("auth: 'accountWithSecondStep'", () => {
  const SECOND_STEP: SignedInEndpointOptions = { ...ACCOUNT, auth: 'accountWithSecondStep' };

  it('refuses a session that still owes its second step, with 403 and CORS', async () => {
    mocks.sessionMissingSecondFactor.mockResolvedValue(true);
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(SECOND_STEP, respond)(event({ httpMethod: 'POST', body: '{}' }));

    expect(response.statusCode).toBe(403);
    expect(errorOf(response)).toBe(SECOND_FACTOR_REQUIRED_ERROR);
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(mocks.sessionMissingSecondFactor).toHaveBeenCalledWith('Bearer token');
    expect(calls).toEqual([]);
  });

  it('lets a session through once the second step is done', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(SECOND_STEP, respond)(event());

    expect(response.statusCode).toBe(200);
    expect(calls[0].user).toEqual(FAN);
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('answers a signed-out caller 401 without asking about the second step', async () => {
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'ip:203.0.113.7', user: null });
    const response = await endpoint(SECOND_STEP, recorder<SignedInRequest>().respond)(event());

    expect(response.statusCode).toBe(401);
    expect(mocks.sessionMissingSecondFactor).not.toHaveBeenCalled();
  });
});

describe("auth: 'admin'", () => {
  const ADMIN_ONLY: SignedInEndpointOptions = { cors: 'site', methods: ['GET', 'POST'], auth: 'admin', jsonBody: true };

  it('hands the function the admin, and spends no rate-limit call', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ADMIN_ONLY, respond)(event());

    expect(response.statusCode).toBe(200);
    expect(mocks.authenticateAdmin).toHaveBeenCalledWith('Bearer token');
    expect(calls[0].user).toEqual(ADMIN);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.resolveAccountRequest).not.toHaveBeenCalled();
  });

  it('answers anyone else 401 with CORS', async () => {
    mocks.authenticateAdmin.mockResolvedValue(null);
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ADMIN_ONLY, respond)(event());

    expect(response.statusCode).toBe(401);
    expect(errorOf(response)).toBe('Unauthorized');
    expect(originOf(response)).toBe(SITE);
    expect(calls).toEqual([]);
  });
});

describe('the rate limiter', () => {
  // The real checkRateLimit builds its 429 from the CORS headers it is handed.
  const limitedWithCors = async (_key: string, _tier: string, corsHeaders: Record<string, string>) => ({
    limited: true,
    response: {
      statusCode: 429,
      headers: { ...corsHeaders, 'Retry-After': '30' },
      body: JSON.stringify({ error: 'Too many requests. Please try again later.' }),
    },
  });

  it("passes a signed-in endpoint's 429 straight through, CORS headers and all", async () => {
    mocks.checkRateLimit.mockImplementation(limitedWithCors);
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event());

    expect(response.statusCode).toBe(429);
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(response.headers['Retry-After']).toBe('30');
    expect(calls).toEqual([]);
  });

  it("passes a public endpoint's 429 straight through, CORS headers and all", async () => {
    mocks.checkRateLimit.mockImplementation(limitedWithCors);
    const { calls, respond } = recorder<PublicRequest>();
    const response = await endpoint(PUBLIC, respond)(event());

    expect(response.statusCode).toBe(429);
    expect(originOf(response)).toBe('*');
    expect(calls).toEqual([]);
  });
});

describe('the JSON body', () => {
  it('hands the function the parsed body', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    await endpoint(ACCOUNT, respond)(event({ httpMethod: 'POST', body: JSON.stringify({ location: 'Brooklyn' }) }));
    expect(calls[0].body).toEqual({ location: 'Brooklyn' });
  });

  it('answers 400 with CORS on a body that is not JSON', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event({ httpMethod: 'POST', body: '{not json' }));

    expect(response.statusCode).toBe(400);
    expect(errorOf(response)).toBe('Invalid JSON');
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(calls).toEqual([]);
  });

  it.each(['null', '[]', '"text"', '7'])('answers 400 on %s, which is JSON but not an object', async (body) => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event({ httpMethod: 'POST', body }));

    expect(response.statusCode).toBe(400);
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(calls).toEqual([]);
  });

  it.each([null, undefined, ''])('treats an empty body (%j) as {}', async (body) => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event({ httpMethod: 'POST', body }));

    expect(response.statusCode).toBe(200);
    expect(calls[0].body).toEqual({});
  });

  it('does not parse the body of a GET', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(ACCOUNT, respond)(event({ body: '{not json' }));

    expect(response.statusCode).toBe(200);
    expect(calls[0].body).toEqual({});
  });

  it('does not parse anything for an endpoint that takes no body', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint({ ...ACCOUNT, jsonBody: false }, respond)(event({ httpMethod: 'POST', body: '{not json' }));

    expect(response.statusCode).toBe(200);
    expect(calls[0].body).toEqual({});
  });

  it('refuses a signed-out caller before reading the body', async () => {
    mocks.resolveAccountRequest.mockResolvedValue({ key: 'ip:203.0.113.7', user: null });
    const response = await endpoint(ACCOUNT, recorder<SignedInRequest>().respond)(event({ httpMethod: 'POST', body: '{not json' }));
    expect(response.statusCode).toBe(401);
  });
});

describe("the function's answer", () => {
  it('is sent as JSON with its status, under the CORS headers', async () => {
    const response = await endpoint(ACCOUNT, async () => ({ status: 409, body: { error: 'Username is already taken' } }))(event());

    expect(response.statusCode).toBe(409);
    expect(response.body).toBe('{"error":"Username is already taken"}');
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(originOf(response)).toBe(LOCAL_DEV);
  });

  it('keeps the headers the function adds, beside the CORS ones', async () => {
    const response = await endpoint(ACCOUNT, async () => ({
      status: 200,
      body: {},
      headers: { 'Cache-Control': 'private, no-store' },
    }))(event());

    expect(response.headers['Cache-Control']).toBe('private, no-store');
    expect(originOf(response)).toBe(LOCAL_DEV);
  });

  it('passes the query string through, and {} when there is none', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    const handler = endpoint(ACCOUNT, respond);

    await handler(event({ queryStringParameters: { since: '2026-11-01T00:00:00Z' } }));
    await handler(event({ queryStringParameters: null }));

    expect(calls[0].query).toEqual({ since: '2026-11-01T00:00:00Z' });
    expect(calls[1].query).toEqual({});
  });
});

describe('an error the function throws', () => {
  it('is reported to Sentry and answered 500 with CORS, not left to escape', async () => {
    const boom = new Error('column does not exist');
    const response = await endpoint(ACCOUNT, async () => {
      throw boom;
    })(event());

    expect(response.statusCode).toBe(500);
    expect(errorOf(response)).toBe('Internal server error');
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureException.mock.calls[0][0]).toBe(boom);
  });

  it('is handled the same when auth itself throws', async () => {
    const boom = new Error('auth server unreachable');
    mocks.authenticateAdmin.mockRejectedValue(boom);
    const response = await endpoint({ cors: 'site', methods: ['GET'], auth: 'admin', jsonBody: false }, recorder<SignedInRequest>().respond)(event());

    expect(response.statusCode).toBe(500);
    expect(originOf(response)).toBe(SITE);
    expect(mocks.captureException.mock.calls[0][0]).toBe(boom);
  });

  it('does not leak the error to the caller', async () => {
    const response = await endpoint(ACCOUNT, async () => {
      throw new Error('secret detail');
    })(event());
    expect(response.body).not.toContain('secret detail');
  });
});

describe("CORS: the endpoint's own methods, and 'none'", () => {
  it("'site' and 'public' advertise the methods the endpoint listed, not the builder's fixed list", async () => {
    const site = await endpoint({ ...ACCOUNT, cors: 'site', methods: ['GET', 'PUT'] }, recorder<SignedInRequest>().respond)(event({ httpMethod: 'OPTIONS' }));
    expect(site.headers['Access-Control-Allow-Methods']).toBe('GET, PUT, OPTIONS');

    const open = await endpoint(PUBLIC, recorder<PublicRequest>().respond)(event({ httpMethod: 'OPTIONS' }));
    expect(open.headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
  });

  it("'public' does not say it varies by Origin: the answer is the same for everyone", async () => {
    const response = await endpoint(PUBLIC, recorder<PublicRequest>().respond)(event({ headers: { origin: FOREIGN } }));
    expect(response.headers.Vary).toBeUndefined();
  });

  it("'none' sends no CORS header at all, and still says its JSON is JSON", async () => {
    const response = await endpoint({ ...PUBLIC, cors: 'none' }, recorder<PublicRequest>().respond)(event({ headers: { origin: FOREIGN } }));

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it("'none' has no preflight: OPTIONS is a 405 like any other method it didn't list", async () => {
    const response = await endpoint({ ...PUBLIC, cors: 'none' }, recorder<PublicRequest>().respond)(event({ httpMethod: 'OPTIONS' }));

    expect(response.statusCode).toBe(405);
    expect(response.headers.Allow).toBe('GET, HEAD');
  });
});

describe('rateLimit shapes', () => {
  it("'none' spends no Redis command", async () => {
    const response = await endpoint({ ...PUBLIC, rateLimit: 'none' }, recorder<PublicRequest>().respond)(event());

    expect(response.statusCode).toBe(200);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('a function of the method picks the tier for each', async () => {
    const options: PublicEndpointOptions = {
      ...PUBLIC,
      methods: ['GET', 'POST'],
      rateLimit: (method) => (method === 'POST' ? 'strict' : 'standard'),
    };
    await endpoint(options, recorder<PublicRequest>().respond)(event());
    await endpoint(options, recorder<PublicRequest>().respond)(event({ httpMethod: 'POST' }));

    expect(mocks.checkRateLimit.mock.calls.map(([key, tier]) => [key, tier])).toEqual([
      ['203.0.113.7', 'standard'],
      ['203.0.113.7', 'strict'],
    ]);
  });

  it("{ tier, by: 'ip' } on an account endpoint limits by IP before the token is read", async () => {
    const order: string[] = [];
    mocks.checkRateLimit.mockImplementation(async () => { order.push('limit'); return { limited: false }; });
    mocks.resolveAccountRequest.mockImplementation(async () => { order.push('token'); return { key: 'user:user-1', user: FAN }; });

    const { calls, respond } = recorder<SignedInRequest>();
    await endpoint({ ...ACCOUNT, rateLimit: { tier: 'strict', by: 'ip' } }, respond)(event());

    expect(order).toEqual(['limit', 'token']);
    // Still one rate-limit call, against the IP rather than the account.
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('203.0.113.7', 'strict', expect.anything());
    expect(calls[0].user).toEqual(FAN);
  });

  it("a request over an IP limit never has its token read", async () => {
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: { statusCode: 429, headers: {}, body: '{}' } });
    const response = await endpoint({ ...ACCOUNT, rateLimit: { tier: 'strict', by: 'ip' } }, recorder<SignedInRequest>().respond)(event());

    expect(response.statusCode).toBe(429);
    expect(mocks.resolveAccountRequest).not.toHaveBeenCalled();
  });

  it('tells the function how long the limit check took', async () => {
    const { calls, respond } = recorder<PublicRequest>();
    await endpoint(PUBLIC, respond)(event());
    expect(calls[0].rateLimitMs).toEqual(expect.any(Number));

    const unlimited = recorder<PublicRequest>();
    await endpoint({ ...PUBLIC, rateLimit: 'none' }, unlimited.respond)(event());
    expect(unlimited.calls[0].rateLimitMs).toBe(0);
  });
});

describe("auth: 'bearer'", () => {
  it('limits by IP, then checks the token against Supabase, and hands over the user', async () => {
    const order: string[] = [];
    mocks.checkRateLimit.mockImplementation(async () => { order.push('limit'); return { limited: false }; });
    mocks.authenticateBearer.mockImplementation(async () => { order.push('supabase'); return FAN; });

    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(BEARER, respond)(event());

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['limit', 'supabase']);
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith('203.0.113.7', 'standard', expect.objectContaining({ 'Access-Control-Allow-Origin': LOCAL_DEV }));
    expect(mocks.authenticateBearer).toHaveBeenCalledWith('Bearer token');
    expect(calls[0].user).toEqual(FAN);
    // The fast local check is the other modes' business.
    expect(mocks.resolveAccountRequest).not.toHaveBeenCalled();
  });

  it('answers 401 with CORS to a token Supabase refuses, a half-finished two-step sign-in included', async () => {
    // authenticateBearer answers null for both: a bad token, and a session that owes its second step.
    mocks.authenticateBearer.mockResolvedValue(null);
    const { calls, respond } = recorder<SignedInRequest>();
    const response = await endpoint(BEARER, respond)(event());

    expect(response.statusCode).toBe(401);
    expect(errorOf(response)).toBe('Authentication required');
    expect(originOf(response)).toBe(LOCAL_DEV);
    expect(calls).toEqual([]);
  });

  it('a request over the limit never reaches Supabase', async () => {
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: { statusCode: 429, headers: {}, body: '{}' } });
    const response = await endpoint(BEARER, recorder<SignedInRequest>().respond)(event());

    expect(response.statusCode).toBe(429);
    expect(mocks.authenticateBearer).not.toHaveBeenCalled();
  });

  it("rateLimit 'none' spends nothing and still authenticates", async () => {
    const response = await endpoint({ ...BEARER, rateLimit: 'none' }, recorder<SignedInRequest>().respond)(event());

    expect(response.statusCode).toBe(200);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.authenticateBearer).toHaveBeenCalledTimes(1);
  });
});

describe("auth: 'internal'", () => {
  it('lets a call with the internal secret through, with no rate limit and no CORS', async () => {
    const { calls, respond } = recorder<PublicRequest>();
    const response = await endpoint(INTERNAL, respond)(event({ httpMethod: 'POST', body: '{"userId":"u1"}' }));

    expect(response.statusCode).toBe(200);
    expect(mocks.isInternalRequest).toHaveBeenCalledWith('Bearer token');
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(calls[0].body).toEqual({ userId: 'u1' });
  });

  it('answers 401 to anything else, before the body is parsed or the function runs', async () => {
    mocks.isInternalRequest.mockReturnValue(false);
    const { calls, respond } = recorder<PublicRequest>();
    const response = await endpoint(INTERNAL, respond)(event({ httpMethod: 'POST', body: 'not json' }));

    expect(response.statusCode).toBe(401);
    expect(errorOf(response)).toBe('Unauthorized');
    expect(calls).toEqual([]);
  });
});

describe("auth: 'apiKey' (the v1 API)", () => {
  const dataOf = (response: { body: string }) => JSON.parse(response.body);

  it('without a key: unstream.stream only, the anonymous quota, and the envelope', async () => {
    const { calls, respond } = recorder<ApiKeyRequest>();
    const response = await endpoint(V1, respond)(event({ headers: { origin: FOREIGN } }));

    expect(response.statusCode).toBe(200);
    expect(originOf(response)).toBe(SITE);
    expect(mocks.checkApiRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkApiRateLimit).toHaveBeenCalledWith(null, '203.0.113.7', expect.anything());
    // The ordinary limiter is not also spent.
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(calls[0].apiKey).toBeNull();
    expect(dataOf(response)).toEqual({
      data: { ok: true },
      meta: { api_version: '1', request_id: expect.any(String), rate_limit: QUOTA },
    });
  });

  it('with a valid key: any origin, the key\'s own quota, and the key handed to the function', async () => {
    mocks.authenticateApiKey.mockResolvedValue(API_KEY);
    const { calls, respond } = recorder<ApiKeyRequest>();
    const response = await endpoint(V1, respond)(event({ headers: { origin: FOREIGN, 'x-api-key': 'uns_abc123' } }));

    expect(mocks.authenticateApiKey).toHaveBeenCalledWith('uns_abc123');
    expect(originOf(response)).toBe('*');
    expect(mocks.checkApiRateLimit).toHaveBeenCalledWith(API_KEY, '203.0.113.7', expect.anything());
    expect(calls[0].apiKey).toEqual(API_KEY);
  });

  it('puts the quota headers and the request id on every answer after the check', async () => {
    const response = await endpoint(V1, async () => ({ status: 404, body: { error: 'Artist not found' } }))(event());

    expect(response.headers).toMatchObject({
      'X-RateLimit-Limit': '30',
      'X-RateLimit-Remaining': '29',
      'X-RateLimit-Reset': '1790000000',
      'X-Request-Id': expect.any(String),
    });
    // The envelope names the quota only on a success.
    expect(dataOf(response)).toEqual({
      data: { error: 'Artist not found' },
      meta: { api_version: '1', request_id: response.headers['X-Request-Id'] },
    });
  });

  it("hands the limiter's own 429 back untouched", async () => {
    const limited = { statusCode: 429, headers: { 'Retry-After': '60' }, body: '{"error":"Daily request limit exceeded. Please try again tomorrow."}' };
    mocks.checkApiRateLimit.mockResolvedValue({ limited: true, response: limited });
    const { calls, respond } = recorder<ApiKeyRequest>();

    expect(await endpoint(V1, respond)(event())).toBe(limited);
    expect(calls).toEqual([]);
  });

  it('wraps its own refusals in the envelope too', async () => {
    const response = await endpoint(V1, recorder<ApiKeyRequest>().respond)(event({ httpMethod: 'POST' }));

    expect(response.statusCode).toBe(405);
    expect(dataOf(response).data).toEqual({ error: 'Method not allowed' });
    expect(dataOf(response).meta.request_id).toBe(response.headers['X-Request-Id']);
  });
});

describe("envelope: 'v1' on a public endpoint", () => {
  it('wraps the body and adds the request id, with no quota to name', async () => {
    const response = await endpoint({ ...PUBLIC, rateLimit: 'none', envelope: 'v1' }, recorder<PublicRequest>().respond)(event());

    expect(JSON.parse(response.body)).toEqual({
      data: { ok: true },
      meta: { api_version: '1', request_id: response.headers['X-Request-Id'] },
    });
  });
});

describe('what the function is handed, beyond the body', () => {
  it('the headers, the path and the whole URL', async () => {
    const { calls, respond } = recorder<PublicRequest>();
    await endpoint(PUBLIC, respond)(event({
      headers: { 'stripe-signature': 't=1,v1=abc' },
      path: '/api/v1/artist/low',
      rawUrl: 'https://unstream.stream/api/v1/artist/low?x=1',
    }));

    expect(calls[0].headers['stripe-signature']).toBe('t=1,v1=abc');
    expect(calls[0].path).toBe('/api/v1/artist/low');
    expect(calls[0].rawUrl).toBe('https://unstream.stream/api/v1/artist/low?x=1');
  });

  it('the body as it was sent, for a signature check, decoded when Netlify base64-encoded it', async () => {
    const { calls, respond } = recorder<PublicRequest>();
    const raw = '{"id":"evt_1",  "type":"checkout.session.completed"}';
    await endpoint({ ...PUBLIC, methods: ['POST'] }, respond)(event({ httpMethod: 'POST', body: raw }));
    await endpoint({ ...PUBLIC, methods: ['POST'] }, respond)(event({
      httpMethod: 'POST',
      body: Buffer.from(raw).toString('base64'),
      isBase64Encoded: true,
    }));

    expect(calls.map((call) => call.rawBody)).toEqual([raw, raw]);
    // jsonBody is false here, so nothing was parsed.
    expect(calls[0].body).toEqual({});
  });

  it('parses a base64-encoded JSON body like any other', async () => {
    const { calls, respond } = recorder<SignedInRequest>();
    await endpoint(ACCOUNT, respond)(event({
      httpMethod: 'POST',
      body: Buffer.from('{"location":"Brooklyn"}').toString('base64'),
      isBase64Encoded: true,
    }));

    expect(calls[0].body).toEqual({ location: 'Brooklyn' });
  });

  it('answers HEAD wherever GET is served, as a GET, without parsing a body', async () => {
    // Calendar clients, image fetchers and uptime checks probe with HEAD; Netlify drops the body.
    const { calls, respond } = recorder<PublicRequest>();
    const response = await endpoint({ ...PUBLIC, jsonBody: true }, respond)(event({ httpMethod: 'HEAD', body: 'not json' }));

    expect(response.statusCode).toBe(200);
    expect(calls[0].method).toBe('GET');
    // Counted like the GET it is.
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('refuses HEAD where GET is not served', async () => {
    const response = await endpoint({ ...PUBLIC, methods: ['POST'] }, recorder<PublicRequest>().respond)(event({ httpMethod: 'HEAD' }));

    expect(response.statusCode).toBe(405);
    expect(response.headers.Allow).toBe('POST, OPTIONS');
  });
});

describe('answers that are not a JSON body', () => {
  it('a result with no body is sent with an empty one', async () => {
    const response = await endpoint(PUBLIC, async () => ({ status: 204 }))(event());

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(originOf(response)).toBe('*');
  });

  it('a raw result is sent as it is, under its own Content-Type, with the CORS headers', async () => {
    const response = await endpoint(PUBLIC, async () => ({
      status: 200,
      raw: 'iVBORw0KGgo=',
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
      isBase64Encoded: true,
    }))(event());

    expect(response).toEqual({
      statusCode: 200,
      headers: expect.objectContaining({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' }),
      body: 'iVBORw0KGgo=',
      isBase64Encoded: true,
    });
  });

  it("a redirect from an endpoint with no CORS carries its Location and nothing else", async () => {
    const response = await endpoint({ ...PUBLIC, cors: 'none', rateLimit: 'none' }, async () => ({
      status: 302,
      raw: '',
      headers: { Location: 'https://unstream.stream/curator/new?buffer=connected' },
    }))(event());

    expect(response).toEqual({
      statusCode: 302,
      headers: { Location: 'https://unstream.stream/curator/new?buffer=connected' },
      body: '',
    });
  });
});
