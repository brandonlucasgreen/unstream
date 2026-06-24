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