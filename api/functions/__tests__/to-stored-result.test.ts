import { describe, it, expect } from 'vitest';
import { toStoredResult } from '../search-sources';

// Minimal stand-in for getArtistBySlug's return shape — toStoredResult only
// reads these fields, so no DB/network mocking is needed for a pure function.
// `slug` is the artist's canonical stored slug, as artistRowToResult sets it.
function dbArtist(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-id',
    slug: 'test-artist',
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
    expect(toStoredResult(null)).toBeNull();
  });

  it('returns null for an unverified row', () => {
    const result = toStoredResult(dbArtist({ matchConfidence: 'unverified' }));
    expect(result).toBeNull();
  });

  it('builds a claimed card with claimedSlug and no knownSlug', () => {
    const result = toStoredResult(dbArtist({ matchConfidence: 'claimed', slug: 'kid-lightbulbs' }));
    expect(result).not.toBeNull();
    expect(result!.id).toBe('claimed-kid-lightbulbs');
    expect(result!.matchConfidence).toBe('claimed');
    expect(result!.claimedSlug).toBe('kid-lightbulbs');
    expect(result!.knownSlug).toBeUndefined();
  });

  it('builds a verified card with knownSlug and no claimedSlug', () => {
    const result = toStoredResult(dbArtist({ slug: 'patrick-hardy' }));
    expect(result).not.toBeNull();
    expect(result!.id).toBe('known-patrick-hardy');
    expect(result!.matchConfidence).toBe('verified');
    expect(result!.knownSlug).toBe('patrick-hardy');
    expect(result!.claimedSlug).toBeUndefined();
  });

  // The regression behind the 2026-09-19 bug report from me:she: searching
  // "me:she" derives the query slug "me-she", which getArtistBySlug tolerantly
  // matches to her canonical slug "meshe" — and the card used to link to the
  // query slug, so /a/me-she 404ed while /a/meshe worked. A result card must
  // always carry the slug from the DB row, never the one derived from the
  // search query.
  it('links to the canonical stored slug, not the query-derived one', () => {
    const result = toStoredResult(dbArtist({ matchConfidence: 'claimed', slug: 'meshe' }));
    expect(result).not.toBeNull();
    expect(result!.claimedSlug).toBe('meshe');
    expect(result!.id).toBe('claimed-meshe');
  });

  // Same bug class, verified artist: "unitcode:machine" is stored as
  // "unitcodemachine", so the query slug "unitcode-machine" must not leak.
  it('links a verified card to the canonical slug when the name contains punctuation', () => {
    const result = toStoredResult(dbArtist({ slug: 'unitcodemachine' }));
    expect(result).not.toBeNull();
    expect(result!.knownSlug).toBe('unitcodemachine');
    expect(result!.id).toBe('known-unitcodemachine');
  });

  // artist_links.display_name is the custom label an artist typed in the profile
  // editor for an "other" link. It has to survive the DB -> card mapping or the
  // link renders as a bare platform id on the most polished results we serve.
  it('carries a stored display name through to the card', () => {
    const result = toStoredResult(
      dbArtist({
        matchConfidence: 'claimed',
        slug: 'kid-lightbulbs',
        platforms: [
          { sourceId: 'other_0', url: 'https://example.com/shop', displayName: 'Tape store' },
          { sourceId: 'bandcamp', url: 'https://artist.bandcamp.com' },
        ],
      }),
    );
    expect(result!.platforms[0].displayName).toBe('Tape store');
    expect(result!.platforms[1].displayName).toBeUndefined();
  });
});