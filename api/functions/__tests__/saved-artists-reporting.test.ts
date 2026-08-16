// Every way /api/saved-artists can refuse or fail a save must reach Sentry.
//
// It reached nothing before. The endpoint logged to console — a Lambda log nobody reads — while
// the browser extension ignored the response entirely and the web app silently rolled its
// optimistic update back. Two bugs lived in that gap for weeks, both answering 400 on every
// attempt: the React artist page sent the artists-table UUID where a slug belongs, and the slug
// format check rejected 24 of the 791 published artist slugs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockCheckSentryDedup: vi.fn(),
  mockGetClientIp: vi.fn(() => '127.0.0.1'),
  mockAuthenticateBearerFast: vi.fn(),
  mockRequestArtistCatalog: vi.fn(() => Promise.resolve()),
  mockCaptureMessage: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock('../db', () => ({ getClient: () => ({ from: mocks.mockFrom }) }));
vi.mock('../ratelimit', () => ({
  // Only a bucket name; the endpoints' own auth is mocked separately.
  accountRateLimitKey: async () => 'user:test-user',
  checkRateLimit: mocks.mockCheckRateLimit,
  checkSentryDedup: mocks.mockCheckSentryDedup,
  getClientIp: mocks.mockGetClientIp,
}));
vi.mock('../middleware', () => ({ authenticateBearerFast: mocks.mockAuthenticateBearerFast }));
vi.mock('../request-catalog', () => ({ requestArtistCatalog: mocks.mockRequestArtistCatalog }));
vi.mock('../../lib/sentry', () => ({
  Sentry: { captureMessage: mocks.mockCaptureMessage, captureException: mocks.mockCaptureException },
}));

import { handler } from '../saved-artists';

/** A Supabase query chain that resolves to `result` however far it is chained. */
function query(result: unknown) {
  const node: Record<string, unknown> = {
    select: () => node,
    eq: () => node,
    ilike: () => node,
    in: () => node,
    update: () => node,
    upsert: () => node,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return node;
}

const NOT_FOUND = { data: null, error: { message: 'No rows', code: 'PGRST116' } };

function post(body: Record<string, unknown>) {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer valid-token' },
    body: JSON.stringify(body),
  };
}

/** The reason tag of the single Sentry event, or null if nothing was reported. */
function reportedReason(): string | null {
  if (mocks.mockCaptureMessage.mock.calls.length === 0) return null;
  const [, options] = mocks.mockCaptureMessage.mock.calls[0];
  return options.tags.reason;
}

function reportedExtra(): Record<string, unknown> {
  const [, options] = mocks.mockCaptureMessage.mock.calls[0];
  return options.extra;
}

describe('saved-artists failure reporting', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mockGetClientIp.mockReturnValue('127.0.0.1');
    mocks.mockCheckRateLimit.mockResolvedValue({ limited: false });
    // Nothing deduped by default, so each test sees its own event.
    mocks.mockCheckSentryDedup.mockResolvedValue(true);
    mocks.mockAuthenticateBearerFast.mockResolvedValue({ userId: 'user-1', email: 'fan@example.com' });
    mocks.mockRequestArtistCatalog.mockResolvedValue(undefined);
    // No artists row, and a save that succeeds — the happy path unless a test overrides it.
    mocks.mockFrom.mockImplementation((table: string) => {
      if (table === 'artists') return query(NOT_FOUND);
      if (table === 'usernames') return query({ data: null });
      return query({
        data: { notes: null, added_at: '2026-08-02T00:00:00Z', last_modified: '2026-08-02T00:00:00Z', device_id: null },
        error: null,
      });
    });
  });

  describe('save: a rejected identifier', () => {
    it('reports the artists-table UUID the React artist page used to send', async () => {
      const res = await handler(post({ artistId: '550e8400-e29b-41d4-a716-446655440000', name: 'Kid Lightbulbs' }));

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('artistId must be an artist slug, not an id');
      expect(reportedReason()).toBe('save-uuid-not-slug');
      // The offending value has to be on the event, or the report can't be acted on.
      expect(reportedExtra().artistSlug).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('reports a slug that cannot be one', async () => {
      const res = await handler(post({ artistId: '<script>alert(1)</script>' }));

      expect(res.statusCode).toBe(400);
      expect(reportedReason()).toBe('save-invalid-slug-format');
    });

    it('reports a missing artistId', async () => {
      const res = await handler(post({ name: 'Kid Lightbulbs' }));

      expect(res.statusCode).toBe(400);
      expect(reportedReason()).toBe('save-missing-artist-id');
    });

    it('truncates an absurdly long value before it reaches a Sentry tag', async () => {
      await handler(post({ artistId: 'a'.repeat(500) }));

      expect(reportedReason()).toBe('save-invalid-slug-format');
      expect(String(reportedExtra().artistSlug).length).toBeLessThanOrEqual(65);
      expect(reportedExtra().artistSlugLength).toBe(500);
    });
  });

  describe('save: identifiers that must NOT be reported', () => {
    // These are the slugs the old 3–20 character bound rejected. A report here would mean the
    // save is still failing.
    it.each([
      'x',
      'bt',
      'radiohead',
      'explosions-in-the-sky',
      'queens-of-the-stone-age',
      'sopor-aeternus-the-ensemble-of-shadows',
      'nameonly-explosionsinthesky-1785600000000',
    ])('saves %s without reporting anything', async slug => {
      const res = await handler(post({ artistId: slug, name: 'Some Artist' }));

      expect(res.statusCode).toBe(200);
      expect(mocks.mockCaptureMessage).not.toHaveBeenCalled();
      expect(mocks.mockCaptureException).not.toHaveBeenCalled();
    });
  });

  describe('save: the write itself failing', () => {
    it('reports the database error rather than only logging it', async () => {
      mocks.mockFrom.mockImplementation((table: string) => {
        if (table === 'artists') return query(NOT_FOUND);
        return query({ data: null, error: { message: 'permission denied for table saved_artists', code: '42501' } });
      });

      const res = await handler(post({ artistId: 'radiohead' }));

      expect(res.statusCode).toBe(500);
      expect(reportedReason()).toBe('save-upsert-failed');
      expect(reportedExtra().dbMessage).toBe('permission denied for table saved_artists');
      expect(reportedExtra().dbCode).toBe('42501');
    });

    it('reports a thrown error as an exception', async () => {
      mocks.mockFrom.mockImplementation(() => {
        throw new Error('connection reset');
      });

      const res = await handler(post({ artistId: 'radiohead' }));

      expect(res.statusCode).toBe(500);
      expect(mocks.mockCaptureException).toHaveBeenCalled();
      const [error, options] = mocks.mockCaptureException.mock.calls[0];
      expect((error as Error).message).toBe('connection reset');
      expect(options.tags.reason).toBe('save-threw');
    });
  });

  describe('remove', () => {
    // Remove used to validate nothing, so a UUID matched no rows and still answered 200 —
    // a success that had done nothing at all.
    it('rejects and reports a UUID instead of answering 200', async () => {
      const res = await handler(post({ action: 'remove', artistId: '550e8400-e29b-41d4-a716-446655440000' }));

      expect(res.statusCode).toBe(400);
      expect(reportedReason()).toBe('remove-uuid-not-slug');
    });

    it('reports a missing artistId', async () => {
      const res = await handler(post({ action: 'remove' }));

      expect(res.statusCode).toBe(400);
      expect(reportedReason()).toBe('remove-missing-artist-id');
    });

    it('still removes a real slug without reporting', async () => {
      const res = await handler(post({ action: 'remove', artistId: 'explosions-in-the-sky' }));

      expect(res.statusCode).toBe(200);
      expect(mocks.mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('reports the database error when the tombstone write fails', async () => {
      mocks.mockFrom.mockImplementation((table: string) => {
        if (table === 'usernames') return query({ data: null });
        return query({ data: null, error: { message: 'deadlock detected', code: '40P01' } });
      });

      const res = await handler(post({ action: 'remove', artistId: 'radiohead' }));

      expect(res.statusCode).toBe(500);
      expect(reportedReason()).toBe('remove-update-failed');
      expect(reportedExtra().dbMessage).toBe('deadlock detected');
    });
  });

  describe('noise control', () => {
    it('keys dedup on the reason, so a client looping on a rejection cannot flood Sentry', async () => {
      await handler(post({ artistId: '550e8400-e29b-41d4-a716-446655440000' }));

      expect(mocks.mockCheckSentryDedup).toHaveBeenCalledWith('saved-artists:save-uuid-not-slug', 300);
      // Varying the slug must not open a new dedup window — the key holds no client-supplied value.
      const [key] = mocks.mockCheckSentryDedup.mock.calls[0];
      expect(key).not.toContain('550e8400');
    });

    it('sends nothing when the reason is already deduped', async () => {
      mocks.mockCheckSentryDedup.mockResolvedValue(false);

      const res = await handler(post({ artistId: '550e8400-e29b-41d4-a716-446655440000' }));

      // Still refused — dedup silences the report, never the validation.
      expect(res.statusCode).toBe(400);
      expect(mocks.mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('does not report an expired session as a failure', async () => {
      mocks.mockAuthenticateBearerFast.mockResolvedValue(null);

      const res = await handler(post({ artistId: 'radiohead' }));

      expect(res.statusCode).toBe(401);
      expect(mocks.mockCaptureMessage).not.toHaveBeenCalled();
      expect(mocks.mockCaptureException).not.toHaveBeenCalled();
    });
  });
});
