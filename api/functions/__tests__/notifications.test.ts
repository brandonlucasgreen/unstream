import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendTransactionalEmail: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../../lib/resend', () => ({
  sendTransactionalEmail: mocks.sendTransactionalEmail,
}));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: mocks.captureException, captureMessage: mocks.captureMessage },
}));

import { sendNotificationOnce } from '../notifications';

/**
 * A minimal stand-in for the two chains sendNotificationOnce actually uses:
 *   .from('email_log').insert({...}).select('id').single()
 *   .from('email_log').update({...}).eq('id', id)
 */
function fakeClient(opts: {
  insertResult: { data: { id: string } | null; error: { code?: string } | null };
  updateResult?: { error: unknown };
}) {
  const updateMock = vi.fn(() => ({
    eq: vi.fn(() => Promise.resolve(opts.updateResult || { error: null })),
  }));
  const insertMock = vi.fn(() => ({
    select: vi.fn(() => ({
      single: vi.fn(() => Promise.resolve(opts.insertResult)),
    })),
  }));
  const from = vi.fn(() => ({ insert: insertMock, update: updateMock }));
  return { from, insertMock, updateMock } as unknown as { from: typeof from; insertMock: typeof insertMock; updateMock: typeof updateMock };
}

const baseParams = {
  notificationType: 'claim_approved_auto',
  referenceId: 'artist-1',
  recipientEmail: 'artist@example.com',
  subject: 'Subject',
  html: '<p>Body</p>',
  text: 'Body',
};

describe('sendNotificationOnce', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('sends the email and records the outcome once the log row is claimed', async () => {
    const client = fakeClient({ insertResult: { data: { id: 'log-1' }, error: null } });
    mocks.sendTransactionalEmail.mockResolvedValue({ ok: true, messageId: 'msg_123' });

    await sendNotificationOnce({ client: client as never, ...baseParams });

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledWith({
      to: baseParams.recipientEmail,
      subject: baseParams.subject,
      html: baseParams.html,
      text: baseParams.text,
    });
    expect(client.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent', resend_message_id: 'msg_123' }),
    );
  });

  it('skips sending when the same notification was already logged (duplicate key)', async () => {
    const client = fakeClient({ insertResult: { data: null, error: { code: '23505' } } });

    await sendNotificationOnce({ client: client as never, ...baseParams });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('reports an unexpected insert error without sending', async () => {
    const client = fakeClient({ insertResult: { data: null, error: { code: 'other' } } });

    await sendNotificationOnce({ client: client as never, ...baseParams });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('logs the failure when Resend rejects the send', async () => {
    const client = fakeClient({ insertResult: { data: { id: 'log-1' }, error: null } });
    mocks.sendTransactionalEmail.mockResolvedValue({ ok: false, error: 'bad address' });

    await sendNotificationOnce({ client: client as never, ...baseParams });

    expect(client.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'bad address' }),
    );
    expect(mocks.captureMessage).toHaveBeenCalled();
  });
});
