// The shared endpoint wrapper (api/functions/http/endpoint.ts). Locked here: every answer carries
// the CORS headers of the shape the endpoint declared, including the refusals the wrapper writes
// itself and the rate limiter's; each auth mode calls the existing auth function it stands for
// and nothing else; and it costs exactly the rate-limit calls the hand-written handlers made.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  resolveAccountRequest: vi.fn(),
  authenticateAdmin: vi.fn(),
  sessionMissingSecondFactor: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  resolveAccountRequest: mocks.resolveAccountRequest,
  getClientIp: () => '203.0.113.7',
}));
vi.mock('../middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware')>()),
  authenticateAdmin: mocks.authenticateAdmin,
  sessionMissingSecondFactor: mocks.sessionMissingSecondFactor,
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException },
}));

import {
  endpoint,
  type EndpointEvent,
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
    expect(response.headers.Allow).toBe('GET, POST, OPTIONS');
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
    expect(calls).toEqual([{ method: 'GET', query: { query: 'argent' }, body: {} }]);
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
