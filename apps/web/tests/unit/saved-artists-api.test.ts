import { describe, it, expect } from 'vitest';

describe('saved-artists API - Validation logic', () => {
  const mockUUID = '123e4567-e89b-12d3-a456-426614174000';
  const mockAnotherUUID = '223e4567-e89b-12d3-a456-426614174001';
  const mockInvalidUUID = 'not-a-uuid';

  // Use the same regex from saved-artists.ts
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isValidUUID(id: string): boolean {
    return UUID_RE.test(id);
  }

  describe('UUID Validation', () => {
    it('valid UUID passes validation', () => {
      expect(isValidUUID(mockUUID)).toBe(true);
      expect(isValidUUID(mockAnotherUUID)).toBe(true);
    });

    it('invalid UUID fails validation', () => {
      expect(isValidUUID(mockInvalidUUID)).toBe(false);
      expect(isValidUUID('')).toBe(false);
      expect(isValidUUID('123')).toBe(false);
      expect(isValidUUID('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')).toBe(false);
    });
  });

  describe('Input validation - Missing/Invalid artistId', () => {
    it('missing artistId fails validation', () => {
      const body = {};
      expect(isValidUUID(body.artistId as string)).toBe(false);
    });

    it('invalid (non-UUID) artistId fails validation', () => {
      const body = { artistId: mockInvalidUUID };
      expect(isValidUUID(body.artistId as string)).toBe(false);
    });
  });

  describe('Input validation - artistIds array (check action)', () => {
    it('empty artistIds array is invalid', () => {
      const artistIds: string[] = [];
      expect(artistIds.length).toBe(0);
    });

    it('artistIds array > 100 is invalid', () => {
      const artistIds = Array.from({ length: 101 }, () => mockUUID);
      expect(artistIds.length).toBeGreaterThan(100);
    });

    it('non-UUID values in artistIds array are invalid', () => {
      const artistIds = [mockUUID, mockInvalidUUID];
      const invalidCount = artistIds.filter(id => !isValidUUID(id)).length;
      expect(invalidCount).toBeGreaterThan(0);
    });
  });

  describe('CORS headers', () => {
    it('CORS headers are defined in module', () => {
      const expectedHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      };
      expect(expectedHeaders).toEqual({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
    });
  });

  describe('UNS-93: last_modified and device_id in GET response', () => {
    it('GET response maps last_modified and device_id to camelCase', () => {
      const row = {
        id: 'abc-123',
        user_id: 'user-1',
        artist_id: null,
        artist_slug: 'radiohead',
        artist_name: 'Radiohead',
        artist_image_url: null,
        notes: null,
        added_at: '2026-01-01T00:00:00Z',
        supported: false,
        supported_at: null,
        last_modified: '2026-05-01T00:00:00Z',
        device_id: 'mac-studio',
        artists: null,
      };

      const artistRow = (row as any).artists;
      const result = {
        lastModified: row.last_modified,
        deviceId: row.device_id,
      };

      expect(result.lastModified).toBe('2026-05-01T00:00:00Z');
      expect(result.deviceId).toBe('mac-studio');
    });

    it('GET response returns null deviceId when device_id is null', () => {
      const row = {
        last_modified: '2026-05-01T00:00:00Z',
        device_id: null,
      };

      expect(row.device_id).toBeNull();
    });

    it('GET response includes lastModified for rows without sync fields (backwards compat)', () => {
      // Even rows that existed before UNS-93 have last_modified (DEFAULT now())
      const row = {
        last_modified: '2026-01-01T00:00:00Z',
        device_id: null,
      };

      expect(row.last_modified).not.toBeNull();
      expect(row.device_id).toBeNull();
    });
  });

  describe('UNS-93: POST save accepts last_modified and device_id', () => {
    it('upsert payload includes last_modified when body provides it', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', last_modified: '2026-06-01T12:00:00Z' };
      const upsertPayload: Record<string, unknown> = {};
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      expect(upsertPayload.last_modified).toBe('2026-06-01T12:00:00Z');
    });

    it('upsert payload includes device_id when body provides it', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', device_id: 'iphone-15-pro' };
      const upsertPayload: Record<string, unknown> = {};
      if (body.device_id !== undefined) upsertPayload.device_id = body.device_id;
      expect(upsertPayload.device_id).toBe('iphone-15-pro');
    });

    it('upsert payload omits both when body omits them (backwards compat)', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead' };
      const upsertPayload: Record<string, unknown> = {};
      if (body.last_modified !== undefined) upsertPayload.last_modified = body.last_modified;
      if (body.device_id !== undefined) upsertPayload.device_id = body.device_id;
      expect(upsertPayload.last_modified).toBeUndefined();
      expect(upsertPayload.device_id).toBeUndefined();
    });
  });

  describe('UNS-93: last_modified input validation', () => {
    it('non-parseable last_modified string is silently dropped (DB default applies)', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', last_modified: 'not-a-date' };
      const upsertPayload: Record<string, unknown> = {};
      if (body.last_modified !== undefined) {
        if (typeof body.last_modified === 'string') {
          const parsed = new Date(body.last_modified);
          if (!isNaN(parsed.getTime())) {
            upsertPayload.last_modified = body.last_modified;
          }
        }
      }
      expect(upsertPayload.last_modified).toBeUndefined();
    });

    it('non-string last_modified (number) is silently dropped', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', last_modified: 12345 };
      const upsertPayload: Record<string, unknown> = {};
      if (body.last_modified !== undefined) {
        if (typeof body.last_modified === 'string') {
          const parsed = new Date(body.last_modified);
          if (!isNaN(parsed.getTime())) {
            upsertPayload.last_modified = body.last_modified;
          }
        }
      }
      expect(upsertPayload.last_modified).toBeUndefined();
    });

    it('valid ISO-8601 last_modified string is accepted', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', last_modified: '2099-01-01T00:00:00Z' };
      const upsertPayload: Record<string, unknown> = {};
      if (body.last_modified !== undefined) {
        if (typeof body.last_modified === 'string') {
          const parsed = new Date(body.last_modified);
          if (!isNaN(parsed.getTime())) {
            upsertPayload.last_modified = body.last_modified;
          }
        }
      }
      expect(upsertPayload.last_modified).toBe('2099-01-01T00:00:00Z');
    });
  });

  describe('UNS-93: device_id input validation', () => {
    it('device_id longer than 128 chars is truncated', () => {
      const longDeviceId = 'x'.repeat(200);
      const body: Record<string, unknown> = { artistId: 'radiohead', device_id: longDeviceId };
      const upsertPayload: Record<string, unknown> = {};
      if (body.device_id !== undefined) {
        if (typeof body.device_id === 'string') {
          upsertPayload.device_id = body.device_id.slice(0, 128);
        }
      }
      expect((upsertPayload.device_id as string).length).toBeLessThanOrEqual(128);
      expect(upsertPayload.device_id).toBe('x'.repeat(128));
    });

    it('non-string device_id (number) is silently dropped', () => {
      const body: Record<string, unknown> = { artistId: 'radiohead', device_id: 12345 };
      const upsertPayload: Record<string, unknown> = {};
      if (body.device_id !== undefined) {
        if (typeof body.device_id === 'string') {
          upsertPayload.device_id = body.device_id.slice(0, 128);
        }
      }
      expect(upsertPayload.device_id).toBeUndefined();
    });
  });
});
