import { describe, it, expect } from 'vitest';
import { toStoredResult } from '../search-sources';

// Minimal stand-in for getArtistBySlug's return shape — toStoredResult only
// reads these fields, so no DB/network mocking is needed for a pure function.
function dbArtist(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-id',
    name: 'Test Artist',
    type: 'artist' as const,
    imageUrl: undefined,
    platforms: [],
    matchConfidence: 'verified' as const,
    profile: undefined,
    location: undefined,
    ...overrides,
  };
}

describe('toStoredResult', () => {
  it('returns null for a null artist', () => {
    expect(toStoredResult(null, 'some-slug')).toBeNull();
  });

  it('returns null for an unverified row', () => {
    const result = toStoredResult(dbArtist({ matchConfidence: 'unverified' }), 'some-slug');
    expect(result).toBeNull();
  });

  it('builds a claimed card with claimedSlug and no knownSlug', () => {
    const result = toStoredResult(dbArtist({ matchConfidence: 'claimed' }), 'kid-lightbulbs');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('claimed-kid-lightbulbs');
    expect(result!.matchConfidence).toBe('claimed');
    expect(result!.claimedSlug).toBe('kid-lightbulbs');
    expect(result!.knownSlug).toBeUndefined();
  });

  it('builds a verified card with knownSlug and no claimedSlug', () => {
    const result = toStoredResult(dbArtist({ matchConfidence: 'verified' }), 'patrick-hardy');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('known-patrick-hardy');
    expect(result!.matchConfidence).toBe('verified');
    expect(result!.knownSlug).toBe('patrick-hardy');
    expect(result!.claimedSlug).toBeUndefined();
  });

  // artist_links.display_name is the custom label an artist typed in the profile
  // editor for an "other" link. It has to survive the DB -> card mapping or the
  // link renders as a bare platform id on the most polished results we serve.
  it('carries a stored display name through to the card', () => {
    const result = toStoredResult(
      dbArtist({
        matchConfidence: 'claimed',
        platforms: [
          { sourceId: 'other_0', url: 'https://example.com/shop', displayName: 'Tape store' },
          { sourceId: 'bandcamp', url: 'https://artist.bandcamp.com' },
        ],
      }),
      'kid-lightbulbs',
    );
    expect(result!.platforms[0].displayName).toBe('Tape store');
    expect(result!.platforms[1].displayName).toBeUndefined();
  });
});
