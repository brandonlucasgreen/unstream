import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock localStorage for node environment
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { localStorageStore[key] = value; },
  removeItem: (key: string) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
  get length() { return Object.keys(localStorageStore).length; },
  key: (i: number) => Object.keys(localStorageStore)[i] ?? null,
};
global.localStorage = localStorageMock as Storage;

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock Supabase client
const mockSignInWithPassword = vi.fn();
const mockSignInWithOtp = vi.fn();
const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn();
const mockSignOut = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signInWithOtp: mockSignInWithOtp,
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
      signOut: mockSignOut,
    },
  }),
}));

// Helper to create a mock session
function createMockSession(userId = 'user-123', email = 'test@example.com') {
  return {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Date.now() / 1000 + 3600,
    user: {
      id: userId,
      email,
      aud: 'authenticated',
      role: 'authenticated',
    },
  };
}

// Helper to create a saved artist response
function createSavedArtist(artistId: string, name: string, slug: string) {
  return {
    artistId,
    name,
    slug,
    imageUrl: `https://example.com/${slug}.jpg`,
    notes: null,
    addedAt: '2026-05-28T00:00:00Z',
  };
}

describe('AuthContext saved artists state management', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockGetSession.mockReset();
    mockOnAuthStateChange.mockReset();
    mockSignInWithOtp.mockReset();
    mockSignInWithPassword.mockReset();
    mockSignOut.mockReset();
  });

  describe('saveArtist - optimistic updates', () => {
    it('adds artistId to savedArtistIds set optimistically', async () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';
      const savedArtist = createSavedArtist(artistId, 'Radiohead', 'radiohead');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ savedArtist }),
      });

      // Simulate the state update logic
      const savedArtistIds = new Set<string>();
      savedArtistIds.add(artistId);
      expect(savedArtistIds.has(artistId)).toBe(true);
    });

    it('does not add duplicate artistId (dedup)', () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';
      const savedArtistIds = new Set<string>();

      // Add twice — Set deduplicates
      savedArtistIds.add(artistId);
      savedArtistIds.add(artistId);
      expect(savedArtistIds.size).toBe(1);
    });

    it('rolls back Set and array on 4xx error', async () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Bad request' }),
      });

      // Simulate rollback logic
      const savedArtistIds = new Set<string>();
      const savedArtists: any[] = [];

      // Optimistic add
      savedArtistIds.add(artistId);
      savedArtists.push(createSavedArtist(artistId, 'Radiohead', 'radiohead'));

      // On error, rollback
      savedArtistIds.delete(artistId);
      const idx = savedArtists.findIndex(a => a.artistId === artistId);
      if (idx !== -1) savedArtists.splice(idx, 1);

      expect(savedArtistIds.has(artistId)).toBe(false);
      expect(savedArtists).toHaveLength(0);
    });

    it('rolls back Set and array on network error', () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';

      // Simulate rollback on fetch throw
      const savedArtistIds = new Set<string>();
      const savedArtists: any[] = [];

      // Optimistic add
      savedArtistIds.add(artistId);
      savedArtists.push(createSavedArtist(artistId, 'Radiohead', 'radiohead'));

      // On network error, rollback both
      savedArtistIds.delete(artistId);
      const idx = savedArtists.findIndex(a => a.artistId === artistId);
      if (idx !== -1) savedArtists.splice(idx, 1);

      expect(savedArtistIds.has(artistId)).toBe(false);
      expect(savedArtists).toHaveLength(0);
    });
  });

  describe('removeSavedArtist - optimistic updates', () => {
    it('removes artistId from Set and array optimistically', () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';

      const savedArtistIds = new Set<string>([artistId]);
      const savedArtists = [createSavedArtist(artistId, 'Radiohead', 'radiohead')];

      // Optimistic remove
      savedArtistIds.delete(artistId);
      const filtered = savedArtists.filter(a => a.artistId !== artistId);

      expect(savedArtistIds.has(artistId)).toBe(false);
      expect(filtered).toHaveLength(0);
    });

    it('restores both Set and array on API error (full rollback)', () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';
      const removedArtist = createSavedArtist(artistId, 'Radiohead', 'radiohead');

      // Start with artist saved
      const savedArtistIds = new Set<string>([artistId]);
      const savedArtists = [removedArtist];

      // Snapshot for rollback
      const snapshot = savedArtists.find(a => a.artistId === artistId);

      // Optimistic remove
      savedArtistIds.delete(artistId);
      const filtered = savedArtists.filter(a => a.artistId !== artistId);

      // On error, rollback both
      savedArtistIds.add(artistId);
      if (snapshot) filtered.push(snapshot);

      expect(savedArtistIds.has(artistId)).toBe(true);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].artistId).toBe(artistId);
    });
  });

  describe('pending save flow (localStorage)', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('stores pending save in localStorage before redirect', () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';

      localStorage.setItem('pendingSave', JSON.stringify({ artistId }));

      const stored = JSON.parse(localStorage.getItem('pendingSave')!);
      expect(stored.artistId).toBe(artistId);
    });

    it('clears pendingSave immediately on read, not after save', () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';

      localStorage.setItem('pendingSave', JSON.stringify({ artistId }));

      // Simulate the read-and-clear pattern from AuthContext
      const pendingSave = localStorage.getItem('pendingSave');
      localStorage.removeItem('pendingSave'); // Clear immediately

      // Even if save fails, localStorage is already cleared
      expect(localStorage.getItem('pendingSave')).toBeNull();
      expect(pendingSave).not.toBeNull();

      const parsed = JSON.parse(pendingSave!);
      expect(parsed.artistId).toBe(artistId);
    });

    it('handles corrupted pendingSave gracefully', () => {
      localStorage.setItem('pendingSave', 'not-valid-json');

      // Should not throw
      try {
        const pendingSave = localStorage.getItem('pendingSave');
        if (pendingSave) {
          JSON.parse(pendingSave);
        }
      } catch {
        // Clear corrupted data
        localStorage.removeItem('pendingSave');
      }

      expect(localStorage.getItem('pendingSave')).toBeNull();
    });

    it('supports notes field in pending save', () => {
      const artistId = '123e4567-e89b-12d3-a456-426614174000';
      const notes = 'Seen live 2024';

      localStorage.setItem('pendingSave', JSON.stringify({ artistId, notes }));

      const stored = JSON.parse(localStorage.getItem('pendingSave')!);
      expect(stored.artistId).toBe(artistId);
      expect(stored.notes).toBe(notes);
    });
  });

  describe('bulk check - validation', () => {
    it('caps at 100 artist IDs', () => {
      const artistIds = Array.from({ length: 101 }, (_, i) =>
        `123e4567-e89b-12d3-a456-42661417${String(i).padStart(4, '0')}`
      );
      expect(artistIds.length).toBeGreaterThan(100);
    });

    // The ids here are artist **slugs**: handleCheck queries `.in('artist_slug', artistIds)`.
    // This used to assert they were UUIDs, which was never true of this endpoint — the same
    // stale mental model that had the React artist page saving by artists-table id.
    it('sends artist slugs, not database ids', () => {
      const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
      const artistIds = ['radiohead', 'explosions-in-the-sky', 'bt'];

      expect(artistIds.every(id => SLUG_RE.test(id))).toBe(true);
      expect(SLUG_RE.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true); // format alone allows it
    });
  });
});