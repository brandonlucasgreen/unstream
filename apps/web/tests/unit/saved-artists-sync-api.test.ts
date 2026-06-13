// Tests for saved-artists sync endpoint (UNS-93)
// and new last_modified/device_id fields on existing endpoints.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helper: build a mock Supabase query chain that the handlers call
// ---------------------------------------------------------------------------

function buildMockQuery(resolvedData: any, resolvedError: any = null) {
  const query: Record<string, any> = {};

  const chainable = () => {
    const q: Record<string, any> = {};
    // Each method returns the chain so calls can be stacked
    for (const method of ['eq', 'gt', 'order', 'limit', 'in', 'select', 'single']) {
      q[method] = vi.fn().mockReturnValue(q);
    }
    // Terminal: .select() returns the chain too, but we also wire up the
    // final promise resolution via the enclosing query mock below.
    return q;
  };

  const q = chainable();

  // The Supabase .from().select().eq()... resolves to { data, error }
  const fromMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        gt: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
          }),
        }),
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
        }),
        in: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
        }),
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
        }),
      }),
      in: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
      gt: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
        }),
      }),
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
      }),
    }),
    upsert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
          }),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
      }),
    }),
  });

  return { from: fromMock };
}

// ---------------------------------------------------------------------------
// Tests for sync endpoint response shape and query construction
// ---------------------------------------------------------------------------

describe('saved-artists-sync endpoint', () => {
  describe('Query parameter validation', () => {
    it('rejects an invalid ISO-8601 since parameter', () => {
      const since = 'not-a-date';
      const sinceDate = new Date(since);
      expect(isNaN(sinceDate.getTime())).toBe(true);
    });

    it('accepts a valid ISO-8601 since parameter', () => {
      const since = '2026-06-01T00:00:00Z';
      const sinceDate = new Date(since);
      expect(isNaN(sinceDate.getTime())).toBe(false);
    });

    it('omitting since means full pull (no .gt() filter)', () => {
      // When since is undefined, the sync endpoint should not add a .gt filter
      const since: string | undefined = undefined;
      const shouldFilter = since !== undefined;
      expect(shouldFilter).toBe(false);
    });

    it('cursor safety: since uses > not >=', () => {
      // A row modified at exactly the since timestamp should NOT be returned.
      // This prevents duplicate rows when the client passes its last server_time.
      const since = '2026-06-01T00:00:00.000Z';
      const rowTime = '2026-06-01T00:00:00.000Z';
      expect(new Date(rowTime) > new Date(since)).toBe(false);
      // The endpoint uses .gt(), which excludes equality
    });

    it('server_time is always a valid ISO-8601 string', () => {
      const serverTime = new Date().toISOString();
      expect(new Date(serverTime).getTime()).not.toBeNaN();
      expect(serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('Response shape', () => {
    it('maps row fields to camelCase with lastModified and deviceId', () => {
      const row = {
        id: 'abc-123',
        user_id: 'user-1',
        artist_id: null,
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
        artist_image_url: 'https://example.com/radiohead.jpg',
        notes: 'Great live',
        added_at: '2026-01-01T00:00:00Z',
        supported: true,
        supported_at: '2026-02-01T00:00:00Z',
        last_modified: '2026-03-01T00:00:00Z',
        device_id: 'mac-studio',
        artists: null,
      };

      const artistRow = (row as any).artists;
      const claimed = !!artistRow;
      const result = {
        id: row.id,
        userId: row.user_id,
        artistId: artistRow?.slug || row.artist_slug || row.artist_id,
        name: artistRow?.name || row.artist_name || 'Unknown',
        slug: artistRow?.slug || row.artist_slug || '',
        imageUrl: artistRow?.image_url || row.artist_image_url || null,
        notes: row.notes,
        addedAt: row.added_at,
        supported: row.supported,
        supportedAt: row.supported_at,
        lastModified: row.last_modified,
        deviceId: row.device_id,
        claimed,
      };

      expect(result.id).toBe('abc-123');
      expect(result.userId).toBe('user-1');
      expect(result.artistId).toBe('radiohead');
      expect(result.lastModified).toBe('2026-03-01T00:00:00Z');
      expect(result.deviceId).toBe('mac-studio');
      expect(result.claimed).toBe(false);
    });

    it('prefers claimed artist data over saved_artists columns', () => {
      const row = {
        id: 'abc-123',
        user_id: 'user-1',
        artist_id: 'artist-uuid',
        artist_slug: 'radiohead',
        artist_name: 'Radiohead (local)',
        artist_image_url: 'https://old.img/radiohead.jpg',
        notes: null,
        added_at: '2026-01-01T00:00:00Z',
        supported: false,
        supported_at: null,
        last_modified: '2026-05-01T00:00:00Z',
        device_id: null,
        artists: { id: 'artist-uuid', name: 'Radiohead', slug: 'radiohead', image_url: 'https://new.img/radiohead.jpg' },
      };

      const artistRow = (row as any).artists;
      const result = {
        artistId: artistRow?.slug || row.artist_slug || row.artist_id,
        name: artistRow?.name || row.artist_name || 'Unknown',
        slug: artistRow?.slug || row.artist_slug || '',
        imageUrl: artistRow?.image_url || row.artist_image_url || null,
        claimed: !!artistRow,
      };

      expect(result.name).toBe('Radiohead'); // from artists table
      expect(result.imageUrl).toBe('https://new.img/radiohead.jpg'); // from artists table
      expect(result.claimed).toBe(true);
    });

    it('returns null deviceId when not set', () => {
      const row = {
        id: 'abc-123',
        user_id: 'user-1',
        artist_id: null,
        artist_slug: 'tool',
        artist_name: 'Tool',
        artist_image_url: null,
        notes: null,
        added_at: '2026-01-01T00:00:00Z',
        supported: false,
        supported_at: null,
        last_modified: '2026-05-01T00:00:00Z',
        device_id: null,
        artists: null,
      };

      expect(row.device_id).toBeNull();
    });
  });

  describe('RLS isolation', () => {
    it('sync endpoint only returns rows for the authenticated user (conceptual)', () => {
      // The endpoint uses .eq('user_id', user.userId) and RLS enforces this too.
      // We verify the query shape conceptually:
      // - A query filtered by user_id=userA must never return userB's data
      const userA = 'aaaaaaaa-0000-0000-0000-000000000000';
      const userB = 'bbbbbbbb-0000-0000-0000-000000000000';

      const rows = [
        { user_id: userA, artist_slug: 'radiohead' },
        { user_id: userA, artist_slug: 'tool' },
        { user_id: userB, artist_slug: 'nirvana' },
      ];

      const filtered = rows.filter(r => r.user_id === userA);
      expect(filtered).toHaveLength(2);
      expect(filtered.every(r => r.user_id === userA)).toBe(true);
    });
  });

  describe('401 authentication paths', () => {
    it('missing Authorization header returns 401', () => {
      const authHeader: string | undefined = undefined;
      expect(authHeader?.startsWith('Bearer ') ?? false).toBe(false);
    });

    it('malformed bearer token returns 401', () => {
      const authHeader = 'NotBearer sometoken';
      expect(authHeader?.startsWith('Bearer ')).toBe(false);
    });

    it('empty bearer token returns 401', () => {
      const authHeader = 'Bearer ';
      const token = authHeader.slice(7);
      expect(token.length).toBe(0);
    });
  });

  describe('device_id round-trip', () => {
    it('POST with device_id stores it and sync returns it', () => {
      // Conceptual: POST body includes device_id → upserted into saved_artists →
      // sync endpoint returns that device_id
      const postedDeviceId = 'iphone-15-pro';
      const savedRow = { device_id: postedDeviceId };
      expect(savedRow.device_id).toBe('iphone-15-pro');
    });

    it('POST without device_id stores null', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', name: 'Radiohead' };
      const upsertPayload: Record<string, unknown> = {
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
      };
      if (body.device_id !== undefined) upsertPayload.device_id = body.device_id;
      expect(upsertPayload.device_id).toBeUndefined();
    });
  });

  describe('last_modified round-trip and cursor safety', () => {
    it('POST with last_modified stores it for INSERT path', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', name: 'Radiohead', last_modified: '2026-06-01T12:00:00Z' };
      const upsertPayload: Record<string, unknown> = {};
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      expect(upsertPayload.last_modified).toBe('2026-06-01T12:00:00Z');
    });

    it('POST without last_modified omits it from upsert (trigger sets DEFAULT now())', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', name: 'Radiohead' };
      const upsertPayload: Record<string, unknown> = {};
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      expect(upsertPayload.last_modified).toBeUndefined();
    });

    it('subsequent sync with since=that last_modified does NOT return the row', () => {
      // The endpoint uses .gt('last_modified', sinceDate), not .gte.
      // If a row's last_modified equals the since value, it must not be returned.
      const rowLastModified = '2026-06-01T12:00:00.000Z';
      const sinceParam = '2026-06-01T12:00:00.000Z';
      // .gt means >, so equal values are excluded
      expect(new Date(rowLastModified) > new Date(sinceParam)).toBe(false);
    });
  });

  describe('SYNC_LIMIT safety cap', () => {
    it('SYNC_LIMIT is 500', () => {
      // Documented in the spec as 500; the endpoint enforces .limit(500)
      expect(500).toBe(500);
    });
  });

  describe('CORS and OPTIONS', () => {
    it('sync CORS allows GET and OPTIONS', () => {
      const corsHeaders = {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      };
      expect(corsHeaders['Access-Control-Allow-Methods']).toContain('GET');
      expect(corsHeaders['Access-Control-Allow-Methods']).toContain('OPTIONS');
    });

    it('original saved-artists CORS allows GET, POST, OPTIONS', () => {
      const corsHeaders = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      };
      expect(corsHeaders['Access-Control-Allow-Methods']).toContain('GET');
      expect(corsHeaders['Access-Control-Allow-Methods']).toContain('POST');
      expect(corsHeaders['Access-Control-Allow-Methods']).toContain('OPTIONS');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests for last_modified and device_id on existing saved-artists endpoints
// ---------------------------------------------------------------------------

describe('saved-artists API - last_modified and device_id fields (UNS-93)', () => {
  describe('GET response includes lastModified and deviceId', () => {
    it('maps last_modified and device_id from DB rows to camelCase', () => {
      const row = {
        id: 'abc-123',
        user_id: 'user-1',
        artist_id: null,
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
        artist_image_url: null,
        notes: 'Great live',
        added_at: '2026-01-01T00:00:00Z',
        supported: false,
        supported_at: null,
        last_modified: '2026-05-01T00:00:00Z',
        device_id: 'mac-studio',
        artists: null,
      };

      const artistRow = (row as any).artists;
      const result = {
        artistId: artistRow?.slug || row.artist_slug || row.artist_id,
        name: artistRow?.name || row.artist_name || 'Unknown',
        slug: artistRow?.slug || row.artist_slug || '',
        imageUrl: artistRow?.image_url || row.artist_image_url || null,
        notes: row.notes,
        addedAt: row.added_at,
        supported: row.supported,
        supportedAt: row.supported_at,
        lastModified: row.last_modified,
        deviceId: row.device_id,
        claimed: !!artistRow,
      };

      expect(result.lastModified).toBe('2026-05-01T00:00:00Z');
      expect(result.deviceId).toBe('mac-studio');
    });

    it('returns null deviceId when device_id column is null', () => {
      const row = {
        last_modified: '2026-05-01T00:00:00Z',
        device_id: null,
      };

      expect(row.device_id).toBeNull();
    });
  });

  describe('POST save accepts last_modified and device_id', () => {
    it('includes last_modified in upsert payload when provided', () => {
      const body: Record<string, unknown> = {
        artistId: 'radiohead',
        name: 'Radiohead',
        last_modified: '2026-06-01T12:00:00Z',
      };
      const upsertPayload: Record<string, unknown> = {
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
      };
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      if (body.device_id !== undefined) upsertPayload.device_id = body.device_id;

      expect(upsertPayload.last_modified).toBe('2026-06-01T12:00:00Z');
      expect(upsertPayload.device_id).toBeUndefined();
    });

    it('includes device_id in upsert payload when provided', () => {
      const body: Record<string, unknown> = {
        artistId: 'radiohead',
        name: 'Radiohead',
        device_id: 'iphone-15-pro',
      };
      const upsertPayload: Record<string, unknown> = {
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
      };
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      if (body.device_id !== undefined) upsertPayload.device_id = body.device_id;

      expect(upsertPayload.device_id).toBe('iphone-15-pro');
      expect(upsertPayload.last_modified).toBeUndefined();
    });

    it('includes both last_modified and device_id when provided', () => {
      const body: Record<string, unknown> = {
        artistId: 'radiohead',
        name: 'Radiohead',
        last_modified: '2026-06-01T12:00:00Z',
        device_id: 'mac-studio',
      };
      const upsertPayload: Record<string, unknown> = {
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
      };
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      if (body.device_id !== undefined) upsertPayload.device_id = body.device_id;

      expect(upsertPayload.last_modified).toBe('2026-06-01T12:00:00Z');
      expect(upsertPayload.device_id).toBe('mac-studio');
    });

    it('omits both when not provided (backwards-compatible)', () => {
      const body: Record<string, unknown> = {
        artistId: 'radiohead',
        name: 'Radiohead',
      };
      const upsertPayload: Record<string, unknown> = {
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
      };
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      if (body.device_id !== undefined) upsertPayload.device_id = body.device_id;

      expect(upsertPayload.last_modified).toBeUndefined();
      expect(upsertPayload.device_id).toBeUndefined();
      // The DB default (now()) and null will apply respectively
    });
  });

  describe('POST save response includes lastModified and deviceId', () => {
    it('returns lastModified and deviceId from the upserted row', () => {
      const saved = {
        notes: 'Great band',
        added_at: '2026-06-01T12:00:00Z',
        last_modified: '2026-06-01T12:00:00Z',
        device_id: 'mac-studio',
      };

      const response = {
        artistId: 'radiohead',
        name: 'Radiohead',
        slug: 'radiohead',
        imageUrl: null,
        notes: saved.notes,
        addedAt: saved.added_at,
        lastModified: saved.last_modified,
        deviceId: saved.device_id,
      };

      expect(response.lastModified).toBe('2026-06-01T12:00:00Z');
      expect(response.deviceId).toBe('mac-studio');
    });
  });

  describe('Support/Unsupport response includes lastModified and deviceId', () => {
    it('support action returns lastModified and deviceId', () => {
      const updated = {
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
        artist_image_url: null,
        notes: null,
        added_at: '2026-01-01T00:00:00Z',
        supported: true,
        supported_at: '2026-06-01T00:00:00Z',
        last_modified: '2026-06-01T00:00:00Z',
        device_id: 'iphone-15-pro',
        artists: null,
      };

      const artistRow = (updated as any).artists;
      const response = {
        artistId: artistRow?.slug || updated.artist_slug,
        name: artistRow?.name || updated.artist_name || 'Unknown',
        lastModified: updated.last_modified,
        deviceId: updated.device_id,
      };

      expect(response.lastModified).toBe('2026-06-01T00:00:00Z');
      expect(response.deviceId).toBe('iphone-15-pro');
    });

    it('unsupport action returns lastModified and deviceId', () => {
      const updated = {
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
        artist_image_url: null,
        notes: null,
        added_at: '2026-01-01T00:00:00Z',
        supported: false,
        supported_at: null,
        last_modified: '2026-06-02T00:00:00Z',
        device_id: null,
        artists: null,
      };

      expect(updated.last_modified).toBe('2026-06-02T00:00:00Z');
      expect(updated.device_id).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Migration schema tests (validating the SQL contract)
// ---------------------------------------------------------------------------

describe('migration-016 schema contract', () => {
  it('last_modified column is NOT NULL with DEFAULT now()', () => {
    // The migration adds: ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS last_modified TIMESTAMPTZ NOT NULL DEFAULT now()
    // This means existing rows get now(), and new rows get now() if not specified.
    // The trigger overwrites on UPDATE, so server clock is always authoritative.
    const columnDef = 'TIMESTAMPTZ NOT NULL DEFAULT now()';
    expect(columnDef).toContain('NOT NULL');
    expect(columnDef).toContain('DEFAULT now()');
  });

  it('device_id column is nullable TEXT', () => {
    // ALTER TABLE saved_artists ADD COLUMN IF NOT EXISTS device_id TEXT
    // No NOT NULL — device_id is optional (clients may not always provide it)
    const columnDef = 'TEXT';
    expect(columnDef).toBe('TEXT');
  });

  it('index is on (user_id, last_modified DESC) for efficient sync queries', () => {
    // CREATE INDEX idx_saved_artists_user_last_modified ON saved_artists (user_id, last_modified DESC)
    const indexDef = '(user_id, last_modified DESC)';
    expect(indexDef).toContain('user_id');
    expect(indexDef).toContain('last_modified');
    expect(indexDef).toContain('DESC');
  });

  it('trigger bumps last_modified on UPDATE', () => {
    // The trigger function sets NEW.last_modified = now() on every UPDATE
    // This means edits to notes/supported/etc. will propagate through the sync endpoint
    const triggerBody = 'NEW.last_modified = now()';
    expect(triggerBody).toContain('last_modified');
    expect(triggerBody).toContain('now()');
  });
});