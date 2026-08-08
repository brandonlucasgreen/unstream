import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies so we can test the handler in isolation
const mockGetClient = vi.fn();
const mockAuthenticateAdmin = vi.fn();
const mockSentryCapture = vi.fn();

vi.mock('../../../../api/functions/db', () => ({
  getClient: () => mockGetClient(),
}));

vi.mock('../../../../api/functions/middleware', () => ({
  authenticateAdmin: (h: string | undefined) => mockAuthenticateAdmin(h),
  buildCorsHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

vi.mock('../../../../api/lib/sentry', () => ({
  Sentry: {
    captureMessage: (msg: string, opts: unknown) => mockSentryCapture(msg, opts),
  },
}));

// Import after mocks are set up
const { handler } = await import('../../../../api/functions/admin-verify');

const ADMIN = { userId: 'admin-123', email: 'admin@unstream.stream' };
const PENDING_REQUEST = {
  id: '11111111-1111-1111-1111-111111111111',
  artist_id: '22222222-2222-2222-2222-222222222222',
  user_id: '33333333-3333-3333-3333-333333333333',
  email: 'artist@example.com',
  message: 'I am the real artist',
  status: 'pending',
  created_at: '2026-06-01T00:00:00Z',
  reviewed_at: null,
  reviewer_notes: null,
};

function makeEvent(body: unknown) {
  return {
    httpMethod: 'POST',
    headers: { authorization: 'Bearer admin-token' },
    body: JSON.stringify(body),
  };
}

function makeClientMock() {
  const fromMock = vi.fn((table: string) => {
    if (table === 'verification_requests') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: PENDING_REQUEST, error: null }),
        })),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
        order: vi.fn().mockReturnThis(),
      };
    }
    if (table === 'artist_profiles') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        insert: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }
    if (table === 'artists') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { name: 'Test Artist', slug: 'test-artist' }, error: null }),
          })),
        })),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }
    if (table === 'email_log') {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'log-1' }, error: null }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
    }
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockReturnThis(),
    };
  });

  return { from: fromMock };
}

describe('admin-verify: approve action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateAdmin.mockResolvedValue(ADMIN);
  });

  it('returns 400 when ownershipVerified is missing', async () => {
    const client = makeClientMock();
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeEvent({
      action: 'approve',
      requestId: PENDING_REQUEST.id,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Approval requires ownership verification');
  });

  it('returns 400 when ownershipVerified is false', async () => {
    const client = makeClientMock();
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeEvent({
      action: 'approve',
      requestId: PENDING_REQUEST.id,
      ownershipVerified: false,
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Approval requires ownership verification');
  });

  it('succeeds when ownershipVerified is true and logs to Sentry', async () => {
    const client = makeClientMock();
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeEvent({
      action: 'approve',
      requestId: PENDING_REQUEST.id,
      ownershipVerified: true,
    }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);

    // Verify Sentry was called with info level
    expect(mockSentryCapture).toHaveBeenCalledWith(
      'Verification request approved',
      expect.objectContaining({
        level: 'info',
        extra: expect.objectContaining({
          requestId: PENDING_REQUEST.id,
          adminId: ADMIN.userId,
        }),
      }),
    );

    // Verify adminEmail is NOT included (PII red line)
    const sentryCall = mockSentryCapture.mock.calls[0][1] as { extra: Record<string, unknown> };
    expect(sentryCall.extra).not.toHaveProperty('adminEmail');
  });

  it('does not require ownershipVerified for reject action', async () => {
    const client = makeClientMock();
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeEvent({
      action: 'reject',
      requestId: PENDING_REQUEST.id,
    }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });
});

// ---------- Admin re-check: artist already claimed by different user ----------

describe('admin-verify: approve with stale request (artist already claimed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateAdmin.mockResolvedValue(ADMIN);
  });

  it('returns 409 when artist_profiles already has a different user_id', async () => {
    const client = makeClientMock();
    // Override the artist_profiles maybeSingle to return a profile
    // owned by a DIFFERENT user than the request
    client.from.mockImplementation((table: string) => {
      if (table === 'verification_requests') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: PENDING_REQUEST, error: null }),
          })),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
          order: vi.fn().mockReturnThis(),
        };
      }
      if (table === 'artist_profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: 'profile-123',
              user_id: '99999999-9999-9999-9999-999999999999', // different user
              verified_at: '2026-06-10T00:00:00Z',
            },
            error: null,
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === 'artists') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { name: 'Test Artist', slug: 'test-artist' }, error: null }),
            })),
          })),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockReturnThis(),
      };
    });

    mockGetClient.mockReturnValue(client);

    const res = await handler(makeEvent({
      action: 'approve',
      requestId: PENDING_REQUEST.id,
      ownershipVerified: true,
    }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain('claimed by another user');
  });

  it('allows approve when artist_profiles has the same user_id', async () => {
    const client = makeClientMock();
    client.from.mockImplementation((table: string) => {
      if (table === 'verification_requests') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: PENDING_REQUEST, error: null }),
          })),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
          order: vi.fn().mockReturnThis(),
        };
      }
      if (table === 'artist_profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: 'profile-123',
              user_id: PENDING_REQUEST.user_id, // same user
              verified_at: '2026-06-10T00:00:00Z',
            },
            error: null,
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === 'artists') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: { name: 'Test Artist', slug: 'test-artist' }, error: null }),
            })),
          })),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === 'email_log') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'log-1' }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockReturnThis(),
      };
    });

    mockGetClient.mockReturnValue(client);

    const res = await handler(makeEvent({
      action: 'approve',
      requestId: PENDING_REQUEST.id,
      ownershipVerified: true,
    }));

    expect(res.statusCode).toBe(200);
  });
});

// ---------- GET path tests ----------

function makeGetClientMock(opts?: {
  requests?: typeof GET_REQUESTS;
  profiles?: typeof GET_PROFILES;
  requestsError?: unknown;
  profilesError?: unknown;
}) {
  const requestsData = opts?.requests ?? GET_REQUESTS;
  const profilesData = opts?.profiles ?? GET_PROFILES;

  const fromMock = vi.fn((table: string) => {
    if (table === 'verification_requests') {
      const chain = {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
      };
      // The second .order() call returns the final result
      chain.order.mockReturnValueOnce(chain).mockReturnValueOnce({
        data: requestsData,
        error: opts?.requestsError ?? null,
      });
      return chain;
    }
    if (table === 'artist_profiles') {
      return {
        select: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({
            data: profilesData,
            error: opts?.profilesError ?? null,
          }),
        }),
      };
    }
    return {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
    };
  });

  return { from: fromMock };
}

const ARTIST_A = { name: 'Sonic Youth', slug: 'sonic-youth' };
const ARTIST_B = { name: 'Fugazi', slug: 'fugazi' };

const GET_REQUESTS = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'a@example.com',
    message: 'I own this artist',
    status: 'pending',
    reviewer_notes: null,
    created_at: '2026-06-01T00:00:00Z',
    reviewed_at: null,
    artist_id: '22222222-2222-2222-2222-222222222222',
    user_id: '33333333-3333-3333-3333-333333333333',
    artists: ARTIST_A,
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    email: 'b@example.com',
    message: null,
    status: 'approved',
    reviewer_notes: 'Checked bandcamp',
    created_at: '2026-05-15T00:00:00Z',
    reviewed_at: '2026-05-16T00:00:00Z',
    artist_id: '55555555-5555-5555-5555-555555555555',
    user_id: '66666666-6666-6666-6666-666666666666',
    artists: ARTIST_B,
  },
];

const GET_PROFILES = [
  { artist_id: '22222222-2222-2222-2222-222222222222', verified_at: '2026-05-10T00:00:00Z' },
  // artist_id for Fugazi has no profile row = not in the profiles result
];

function makeGetEvent() {
  return {
    httpMethod: 'GET',
    headers: { authorization: 'Bearer admin-token' },
    body: undefined,
  };
}

describe('admin-verify: GET queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateAdmin.mockResolvedValue(ADMIN);
  });

  it('returns 200 with the request list', async () => {
    const client = makeGetClientMock();
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeGetEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toMatchObject({
      id: GET_REQUESTS[0].id,
      artist_name: 'Sonic Youth',
      artist_slug: 'sonic-youth',
      email: 'a@example.com',
      status: 'pending',
    });
  });

  it('sets link_back_completed from the separate artist_profiles query', async () => {
    const client = makeGetClientMock();
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeGetEvent());
    const body = JSON.parse(res.body);

    // Artist A has a profile with verified_at => true
    expect(body.requests[0].link_back_completed).toBe(true);
    // Artist B has no profile row => false
    expect(body.requests[1].link_back_completed).toBe(false);
  });

  it('does not use an embed for artist_profiles (regression test for PGRST200)', async () => {
    const client = makeGetClientMock();
    mockGetClient.mockReturnValue(client);

    await handler(makeGetEvent());

    // The verification_requests select should NOT include artist_profiles in the select string
    const vrCall = client.from.mock.calls.find(c => c[0] === 'verification_requests');
    expect(vrCall).toBeDefined();
    // from() returns a chain; the .select() was called with a string arg.
    // We inspect the first select call on the verification_requests chain.
    const vrResult = client.from.mock.results.find(
      r => r.value && typeof r.value.select === 'function' && r.value.select.mock,
    ) as { value: { select: { mock: { calls: unknown[][] } } } } | undefined;
    expect(vrResult).toBeDefined();
    const selectArg = vrResult!.value.select.mock.calls[0][0] as string;
    expect(selectArg).not.toContain('artist_profiles');

    // artist_profiles should be fetched separately via .in()
    const profileCall = client.from.mock.calls.find(c => c[0] === 'artist_profiles');
    expect(profileCall).toBeDefined();
  });

  it('returns 500 if the artist_profiles query fails', async () => {
    const client = makeGetClientMock({
      profilesError: { code: 'PGRST200', message: 'Could not find a relationship' },
    });
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeGetEvent());
    expect(res.statusCode).toBe(500);
  });

  it('returns 500 if the verification_requests query fails', async () => {
    const client = makeGetClientMock({
      requestsError: { code: 'PGRST200', message: 'relation not found' },
    });
    mockGetClient.mockReturnValue(client);

    const res = await handler(makeGetEvent());
    expect(res.statusCode).toBe(500);
  });
});
