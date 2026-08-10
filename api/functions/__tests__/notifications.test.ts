import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { sendNotificationOnce, notifySavedArtistsOfNewRelease, notifySavedArtistsOfNewLinks, filterByPreference } from '../notifications';

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

interface ReleaseRow {
  title: string;
  slug: string;
  release_date: string | null;
  date_precision: string | null;
  release_sources: { platform: string }[] | null;
}

/**
 * A fuller fake client for the fanout functions, which call sendNotificationOnce and
 * filterByPreference for real (only sendTransactionalEmail is mocked), so it needs to answer
 * `saved_artists`, `artists`, `releases`, `email_log`, `notification_preferences`, and
 * `auth.admin.getUserById` all in one client.
 */
function makeFanoutClient(opts: {
  savedArtists?: { data: { user_id: string }[] | null; error?: unknown };
  artistRow?: { data: { name: string; slug: string } | null; error?: unknown };
  releases?: { data: ReleaseRow[] | null; error?: unknown };
  emails?: Record<string, string>;
  optedOut?: Record<string, boolean>;
}) {
  const savedArtistsResult = opts.savedArtists ?? { data: [], error: null };
  const artistRowResult = opts.artistRow ?? { data: null, error: null };
  const releasesResult = opts.releases ?? { data: [], error: null };
  const emails = opts.emails ?? {};
  const optedOut = opts.optedOut ?? {};

  const from = vi.fn((table: string) => {
    if (table === 'saved_artists') {
      return { select: () => ({ eq: () => ({ eq: () => Promise.resolve(savedArtistsResult) }) }) };
    }
    if (table === 'artists') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(artistRowResult) }) }) };
    }
    if (table === 'releases') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                limit: (n: number) =>
                  Promise.resolve({
                    data: releasesResult.data ? releasesResult.data.slice(0, n) : null,
                    error: releasesResult.error ?? null,
                  }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'notification_preferences') {
      return {
        select: () => ({
          in: (_col: string, userIds: string[]) =>
            Promise.resolve({
              data: userIds
                .filter(id => id in optedOut)
                .map(id => ({ user_id: id, new_release: !optedOut[id], new_platform_link: !optedOut[id], weekly_analytics_recap: !optedOut[id] })),
              error: null,
            }),
        }),
      };
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

const ADMIN_EMAIL = 'admin@example.com';

/** One admin saver (u2) and one ordinary fan (u1) — the shape every admin-gating test needs. */
function releaseClient(overrides: Parameters<typeof makeFanoutClient>[0] = {}) {
  return makeFanoutClient({
    savedArtists: { data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null },
    artistRow: { data: { name: 'Test Artist', slug: 'test-artist' }, error: null },
    emails: { u1: 'fan1@example.com', u2: ADMIN_EMAIL },
    ...overrides,
  });
}

describe('notifySavedArtistsOfNewRelease', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ADMIN_EMAIL = ADMIN_EMAIL;
    mocks.sendTransactionalEmail.mockResolvedValue({ ok: true, messageId: 'msg_1' });
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it('does nothing when nobody saved the artist', async () => {
    const client = makeFanoutClient({ savedArtists: { data: [], error: null } });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('emails admin savers only, and leaves ordinary fans out', async () => {
    const client = releaseClient();

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendTransactionalEmail.mock.calls[0][0].to).toBe(ADMIN_EMAIL);
    expect(mocks.sendTransactionalEmail.mock.calls[0][0].html).toContain('unstream.stream/a/test-artist');
  });

  it('sends to nobody and reports it when ADMIN_EMAIL is not configured', async () => {
    delete process.env.ADMIN_EMAIL;
    const client = releaseClient();

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(expect.stringContaining('ADMIN_EMAIL'), 'error');
  });

  it('names the release, its date, and the platforms it can be bought on', async () => {
    const client = releaseClient({
      releases: {
        data: [{
          title: 'Fine Motor Control',
          slug: 'fine-motor-control',
          release_date: '2026-08-12',
          date_precision: 'day',
          // Deliberately lowest-payout-first, to prove the ordering is applied.
          release_sources: [{ platform: 'discogs' }, { platform: 'bandcamp' }],
        }],
        error: null,
      },
    });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    const sent = mocks.sendTransactionalEmail.mock.calls[0][0];
    expect(sent.subject).toBe('New release from Test Artist: Fine Motor Control');
    expect(sent.html).toContain('Fine Motor Control');
    expect(sent.html).toContain('12 August 2026');
    expect(sent.html).toContain('Available on Bandcamp, Discogs');
    expect(sent.html).toContain('unstream.stream/a/test-artist/fine-motor-control');
    expect(sent.text).toContain('12 August 2026 · Available on Bandcamp, Discogs');
  });

  it('says the date is not listed rather than inventing one', async () => {
    const client = releaseClient({
      releases: {
        data: [{ title: 'Untitled', slug: 'untitled', release_date: null, date_precision: null, release_sources: [] }],
        error: null,
      },
    });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    expect(mocks.sendTransactionalEmail.mock.calls[0][0].html).toContain('Release date not listed');
  });

  it('lists at most five releases and counts the rest', async () => {
    const client = releaseClient({
      releases: {
        data: Array.from({ length: 8 }, (_, i) => ({
          title: `Release ${i}`,
          slug: `release-${i}`,
          release_date: '2026-08-12',
          date_precision: 'day',
          release_sources: [{ platform: 'bandcamp' }],
        })),
        error: null,
      },
    });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 12, previousReleasesFound: 4 });

    const sent = mocks.sendTransactionalEmail.mock.calls[0][0];
    expect(sent.subject).toBe('8 new releases from Test Artist');
    expect(sent.html).toContain('Release 4');
    expect(sent.html).not.toContain('Release 5');
    expect(sent.html).toContain('…and 3 more.');
  });

  it('still sends the alert when the release detail read fails', async () => {
    const client = releaseClient({ releases: { data: null, error: { message: 'boom' } } });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendTransactionalEmail.mock.calls[0][0].subject).toBe('New release from Test Artist');
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('carries the opt-out footer and a List-Unsubscribe header', async () => {
    const client = releaseClient();

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    const sent = mocks.sendTransactionalEmail.mock.calls[0][0];
    expect(sent.html).toContain('https://unstream.stream/settings#notifications');
    expect(sent.html).toContain("You're receiving this because you saved Test Artist on Unstream");
    expect(sent.text).toContain('https://unstream.stream/settings#notifications');
    expect(sent.headers).toEqual({ 'List-Unsubscribe': '<https://unstream.stream/settings#notifications>' });
  });

  it('does not email an admin who turned new-release alerts off', async () => {
    const client = releaseClient({ optedOut: { u2: true } });

    await notifySavedArtistsOfNewRelease({ client, artistId: 'artist-1', releasesFound: 5, previousReleasesFound: 4 });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe('notifySavedArtistsOfNewLinks', () => {
  const linkParams = {
    artistId: 'artist-1',
    artistName: 'Test Artist',
    artistSlug: 'test-artist',
    platforms: ['patreon'],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ADMIN_EMAIL = ADMIN_EMAIL;
    mocks.sendTransactionalEmail.mockResolvedValue({ ok: true, messageId: 'msg_1' });
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it('does nothing when no platforms were discovered', async () => {
    const client = makeFanoutClient({ savedArtists: { data: [{ user_id: 'u1' }], error: null } });

    await notifySavedArtistsOfNewLinks({ client, ...linkParams, platforms: [] });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('emails admin savers only, naming the platforms as people know them', async () => {
    const client = makeFanoutClient({
      savedArtists: { data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null },
      emails: { u1: 'fan1@example.com', u2: ADMIN_EMAIL },
    });

    await notifySavedArtistsOfNewLinks({ client, ...linkParams });

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    const sent = mocks.sendTransactionalEmail.mock.calls[0][0];
    expect(sent.to).toBe(ADMIN_EMAIL);
    expect(sent.html).toContain('Patreon');
    expect(sent.html).toContain('https://unstream.stream/settings#notifications');
    expect(sent.headers).toEqual({ 'List-Unsubscribe': '<https://unstream.stream/settings#notifications>' });
  });

  it('sends to nobody and reports it when ADMIN_EMAIL is not configured', async () => {
    delete process.env.ADMIN_EMAIL;
    const client = makeFanoutClient({
      savedArtists: { data: [{ user_id: 'u1' }], error: null },
      emails: { u1: 'fan1@example.com' },
    });

    await notifySavedArtistsOfNewLinks({ client, ...linkParams });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(mocks.captureMessage).toHaveBeenCalledWith(expect.stringContaining('ADMIN_EMAIL'), 'error');
  });

  it('excludes the claimant from the saver fanout', async () => {
    const client = makeFanoutClient({
      savedArtists: { data: [{ user_id: 'claimer' }, { user_id: 'fan' }], error: null },
      emails: { claimer: 'claimer@example.com', fan: ADMIN_EMAIL },
    });

    await notifySavedArtistsOfNewLinks({ client, ...linkParams, excludeUserId: 'claimer' });

    expect(mocks.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendTransactionalEmail.mock.calls[0][0].to).toBe(ADMIN_EMAIL);
  });

  it('does not email an admin who turned new-platform-link alerts off', async () => {
    const client = makeFanoutClient({
      savedArtists: { data: [{ user_id: 'u1' }, { user_id: 'u2' }], error: null },
      emails: { u1: 'fan1@example.com', u2: ADMIN_EMAIL },
      optedOut: { u2: true },
    });

    await notifySavedArtistsOfNewLinks({ client, ...linkParams });

    expect(mocks.sendTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe('filterByPreference', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns everyone unchanged when the list is empty', async () => {
    const client = makeFanoutClient({});
    expect(await filterByPreference(client, [], 'new_release')).toEqual([]);
  });

  it('drops only the user ids with that column explicitly false', async () => {
    const client = makeFanoutClient({ optedOut: { u1: true } });

    const result = await filterByPreference(client, ['u1', 'u2'], 'new_release');

    expect(result).toEqual(['u2']);
  });

  it('fails open (keeps everyone) when the preference lookup errors', async () => {
    const client = {
      from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never;

    const result = await filterByPreference(client, ['u1', 'u2'], 'new_release');

    expect(result).toEqual(['u1', 'u2']);
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
