import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mirrors ratelimit.ts's RateLimitResult, whose `response` is optional — without the
// annotation the mock's type is inferred from its default and can't be given a 429.
interface RateLimitResult {
  limited: boolean;
  response?: { statusCode: number; headers: Record<string, string>; body: string };
}

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(() => Promise.resolve({ limited: false } as RateLimitResult)),
  getClientIp: vi.fn(() => '127.0.0.1'),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../ratelimit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIp: mocks.getClientIp,
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage },
}));

import { handler } from '../newsletter-subscribe';

function post(body: unknown) {
  return { httpMethod: 'POST', headers: {}, body: JSON.stringify(body) };
}

/** Stand in for a Buttondown response. Only the bits the handler reads. */
function buttondownReply(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(payload === undefined ? '' : JSON.stringify(payload)),
  } as unknown as Response;
}

describe('newsletter-subscribe handler', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ limited: false });
    mocks.getClientIp.mockReturnValue('127.0.0.1');
    process.env.BUTTONDOWN_API_KEY = 'test-key';
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BUTTONDOWN_API_KEY;
  });

  it('subscribes a valid address and reports it as pending confirmation', async () => {
    fetchMock.mockResolvedValue(buttondownReply(201, { id: 'abc' }));

    const res = await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'pending' });
  });

  it('does not send a subscriber type, so Buttondown runs its double opt-in', async () => {
    fetchMock.mockResolvedValue(buttondownReply(201, { id: 'abc' }));

    await handler(post({ email: 'fan@example.com', source: 'guides' }));

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    // `type: 'regular'` would bypass the confirmation email and let anyone subscribe an
    // address they don't own. Its absence is the feature.
    expect(sent).not.toHaveProperty('type');
    expect(sent.email_address).toBe('fan@example.com');
    expect(sent.tags).toEqual(['guides']);
  });

  it('drops an unrecognised source rather than forwarding it as a tag', async () => {
    fetchMock.mockResolvedValue(buttondownReply(201, { id: 'abc' }));

    await handler(post({ email: 'fan@example.com', source: 'attacker-controlled' }));

    // Buttondown creates tags on demand, so forwarding arbitrary input would let anyone
    // fill the account with junk tags.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('tags');
  });

  it('sends the API key as a Token header and never in the body', async () => {
    fetchMock.mockResolvedValue(buttondownReply(201, { id: 'abc' }));

    await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.buttondown.com/v1/subscribers');
    expect(init.headers.Authorization).toBe('Token test-key');
    expect(init.body).not.toContain('test-key');
  });

  it('treats an existing subscriber as success, not an error', async () => {
    fetchMock.mockResolvedValue(buttondownReply(400, { code: 'email_already_exists' }));

    const res = await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'already_subscribed' });
  });

  it('passes on an address Buttondown itself rejects', async () => {
    fetchMock.mockResolvedValue(buttondownReply(400, { code: 'email_invalid' }));

    const res = await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/different one/i);
  });

  it('reports an upstream failure instead of claiming the signup worked', async () => {
    fetchMock.mockResolvedValue(buttondownReply(500, { detail: 'boom' }));

    const res = await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).not.toHaveProperty('status');
    expect(mocks.captureMessage).toHaveBeenCalled();
  });

  it('reports a network failure rather than guessing either way', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));

    const res = await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    expect(res.statusCode).toBe(502);
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('fails loudly when the API key is missing, so lost signups are visible', async () => {
    delete process.env.BUTTONDOWN_API_KEY;

    const res = await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    expect(res.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('BUTTONDOWN_API_KEY'),
      'error',
    );
  });

  it.each([
    ['', 'empty'],
    ['not-an-email', 'no @'],
    ['no@domain', 'no dot in the domain'],
    ['a'.repeat(250) + '@example.com', 'over the 254-character limit'],
  ])('rejects %s (%s) without calling Buttondown', async (email) => {
    const res = await handler(post({ email, source: 'changelog' }));

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-POST method', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {}, body: null });

    expect(res.statusCode).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the rate limiter response when the caller is limited', async () => {
    const limited = { statusCode: 429, headers: {}, body: '{"error":"Too many requests"}' };
    mocks.checkRateLimit.mockResolvedValue({ limited: true, response: limited });

    const res = await handler(post({ email: 'fan@example.com', source: 'changelog' }));

    expect(res).toBe(limited);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
