import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage },
}));

import { sendTransactionalEmail } from '../../lib/resend';

function resendReply(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(payload === undefined ? '' : JSON.stringify(payload)),
  } as unknown as Response;
}

describe('sendTransactionalEmail', () => {
  const fetchMock = vi.fn();
  const params = { to: 'artist@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.RESEND_API_KEY = 'test-key';
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
  });

  it('sends the email and returns the Resend message id', async () => {
    fetchMock.mockResolvedValue(resendReply(200, { id: 'msg_123' }));

    const result = await sendTransactionalEmail(params);

    expect(result).toEqual({ ok: true, messageId: 'msg_123' });
  });

  it('sends the API key as a Bearer header and never in the body', async () => {
    fetchMock.mockResolvedValue(resendReply(200, { id: 'msg_123' }));

    await sendTransactionalEmail(params);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.body).not.toContain('test-key');
    expect(JSON.parse(init.body)).toMatchObject({
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });
  });

  it('fails loudly when RESEND_API_KEY is missing, so a lost notification is visible', async () => {
    delete process.env.RESEND_API_KEY;

    const result = await sendTransactionalEmail(params);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('RESEND_API_KEY'),
      'error',
    );
  });

  it('reports an upstream failure instead of claiming the send worked', async () => {
    fetchMock.mockResolvedValue(resendReply(422, { message: 'invalid from address' }));

    const result = await sendTransactionalEmail(params);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid from address');
    expect(mocks.captureMessage).toHaveBeenCalled();
  });

  it('reports a network failure rather than guessing either way', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));

    const result = await sendTransactionalEmail(params);

    expect(result.ok).toBe(false);
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
