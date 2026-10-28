import { describe, it, expect, vi, beforeEach } from 'vitest';

// Now-playing detection (the extension and Mac app search in exact mode) used to find a claimed
// profile only at the slug of the query. Artists who share a name are stored at addresses that
// tell them apart (`xparacosm`, `paracosm-orlando`), so once one of them claimed, a detection of
// "Paracosm" playing could never show their profile. Exact mode now also asks for claimed
// profiles with exactly that name.

const db = vi.hoisted(() => ({
  getArtistBySlug: vi.fn(),
  getArtistsBySlugs: vi.fn(),
  findKnownArtistSlugsByName: vi.fn(),
  findClaimedArtistSlugsByExactName: vi.fn(),
}));

vi.mock('../db', async () => {
  const { artistSlug } = await import('../../shared/artist-slug');
  return { ...db, artistSlug };
});

import { findStoredArtists } from '../stored-artists';

function row(slug: string, name: string, matchConfidence: 'claimed' | 'verified') {
  return { id: `id-${slug}`, slug, name, type: 'artist' as const, platforms: [], matchConfidence };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.getArtistBySlug.mockResolvedValue(null);
  db.findKnownArtistSlugsByName.mockResolvedValue([]);
  db.findClaimedArtistSlugsByExactName.mockResolvedValue([]);
  db.getArtistsBySlugs.mockImplementation(async (slugs: string[]) =>
    new Map(slugs.map(s => [s, row(s, s === 'xparacosm' ? 'paracosm' : 'Paracosm', 'claimed')])));
});

describe('findStoredArtists in exact mode', () => {
  it('finds a claimed same-name artist stored away from the name\'s slug', async () => {
    db.findClaimedArtistSlugsByExactName.mockResolvedValue(['xparacosm']);

    const stored = await findStoredArtists('Paracosm', 'exact');

    expect(db.findClaimedArtistSlugsByExactName).toHaveBeenCalledWith('Paracosm');
    expect(db.findKnownArtistSlugsByName).not.toHaveBeenCalled();
    expect(stored.map(s => s.claimedSlug)).toEqual(['xparacosm']);
  });

  it('lists a profile found both by slug and by name once', async () => {
    db.getArtistBySlug.mockResolvedValue(row('paracosm', 'Paracosm', 'claimed'));
    db.findClaimedArtistSlugsByExactName.mockResolvedValue(['paracosm', 'paracosm-orlando']);

    const stored = await findStoredArtists('Paracosm', 'exact');

    expect(stored.map(s => s.claimedSlug)).toEqual(['paracosm', 'paracosm-orlando']);
  });
});

describe('findStoredArtists in fuzzy mode', () => {
  it('still uses name-contains, which already covers claimed profiles', async () => {
    db.findKnownArtistSlugsByName.mockResolvedValue(['xparacosm']);

    await findStoredArtists('Paracosm', 'fuzzy');

    expect(db.findKnownArtistSlugsByName).toHaveBeenCalledWith('Paracosm');
    expect(db.findClaimedArtistSlugsByExactName).not.toHaveBeenCalled();
  });
});
