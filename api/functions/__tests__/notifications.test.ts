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

import { sendNotificationOnce, notifySavedArtistsOfNewRelease, notifySavedArtistsOfNewLinks } from '../notifications';

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

/**
 * A fuller fake client for the fanout functions, which call sendNotificationOnce for real
 * (it isn't mocked — only sendTransactionalEmail is), so it needs to answer `saved_artists`,
 * `artists`, `email_log`, and `auth.admin.getUserById` all in one client.
 */
function makeFanoutClient(opts: {
  savedArtists?: { data: { user_id: string }[] | null; error?: unknown };
  artistRow?: { data: { name: string; slug: string } | null; error?: unknown };
  emails?: Record<string, string>;
}) {
  const savedArtistsResult = opts.savedArtists ?? { data: [], error: null };
  const artistRowResult = opts.artistRow ?? { data: null, error: null };
  const emails = opts.emails ?? {};

  const from = vi.fn((table: string) => {
    if (table === 'saved_artists') {
      return { select: () => ({ eq: () => ({ eq: () => Promise.resolve(savedArtistsResult) }) }) };
    }
    if (table === 'artists') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(artistRowResult) }) }) };
    }
    if (table === 'email_log') {
      return {
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: { id: `log-${Math.random()}` }, error: null }) }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });

  const getUserById = vi.fn((userId: string) =>
    Promise.resolve(emails[userId] ? { data: { user: { email: emails[userId] } }, error: null } : { data: { user: null }, error: null }),
  );

  return { from, auth: { admin: { getUserById } } } as never;
}

describe('notifySavedArtistsOfNewRelease', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sendTransactionalEmail.mockResolvedValue({ ok: true, messageId: 'msg_1' });
  });

  it('does nothing when nobody saved the artist', async () => {
    const client = makeFanoutClient({ savedArtists: { data: [], error: null } });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5 });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('emails every saver about the artist by name, linking to their profile', async () => {
    const client = makeFanoutClient({
      savedArtists: { data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null },
      artistRow: { data: { name: 'Test Artist', slug: 'test-artist' }, error: null },
      emails: { u1: 'fan1@example.com', u2: 'fan2@example.com' },
    });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5 });

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledTimes(2);
    const recipients = mocks.sendTransactionalEmail.mock.calls.map(([params]) => params.to);
    expect(recipients).toEqual(['fan1@example.com', 'fan2@example.com']);
    expect(mocks.sendTransactionalEmail.mock.calls[0][0].html).toContain('unstream.stream/a/test-artist');
  });
});

describe('notifySavedArtistsOfNewLinks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sendTransactionalEmail.mockResolvedValue({ ok: true, messageId: 'msg_1' });
  });

  it('does nothing when no platforms were discovered', async () => {
    const client = makeFanoutClient({ savedArtists: { data: [{ user_id: 'u1' }], error: null } });

    await notifySavedArtistsOfNewLinks({
      client,
      artistId: 'artist-1',
      artistName: 'Test Artist',
      artistSlug: 'test-artist',
      platforms: [],
    });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('excludes the claimant from the saver fanout', async () => {
    const client = makeFanoutClient({
      savedArtists: { data: [{ user_id: 'claimer' }, { user_id: 'fan' }], error: null },
      emails: { claimer: 'claimer@example.com', fan: 'fan@example.com' },
    });

    await notifySavedArtistsOfNewLinks({
      client,
      artistId: 'artist-1',
      artistName: 'Test Artist',
      artistSlug: 'test-artist',
      platforms: ['patreon'],
      excludeUserId: 'claimer',
    });

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendTransactionalEmail.mock.calls[0][0].to).toBe('fan@example.com');
    expect(mocks.sendTransactionalEmail.mock.calls[0][0].html).toContain('patreon');
  });
});
