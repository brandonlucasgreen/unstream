import { describe, it, expect } from 'vitest';
import { attachArtistPageSlugs } from '../search-sources';
import { recordSlugs } from '../search-utils';
import { artistSlug } from '../db';
import type { AggregatedResult } from '../search-utils';

// The address of an artist's page, returned so a native client can actually reach their releases.
//
// The bug this closes: a search result carried a slug only when it came off the DB-served path
// (`toStoredResult`), so a live-resolved search returned none. Measured against production —
// six real searches, and only the single *claimed* artist came back addressable, while every one
// of the six had a row holding 16-21 catalogued releases. The Mac app could find an artist and
// then had nowhere to go.
//
// What must not regress: handing out a slug for a row that doesn't exist. That produces a 404 in
// the client for an artist it just displayed, which reads as the app being broken.

function result(overrides: Partial<AggregatedResult> = {}): AggregatedResult {
  return {
    id: 'r1',
    name: 'Explosions in the Sky',
    type: 'artist',
    platforms: [],
    matchConfidence: 'verified',
    ...overrides,
  } as AggregatedResult;
}

describe('attachArtistPageSlugs', () => {
  it('gives a verified artist the slug their row was persisted under', () => {
    const results = [result()];
    attachArtistPageSlugs(results);

    // Must match `artistSlug()` exactly — it is what persistSearchResults upserts on.
    expect(results[0].knownSlug).toBe('explosions-in-the-sky');
  });

  it('leaves a claimed artist alone', () => {
    // Overwriting would swap a real claimed page for a guess at one.
    const results = [result({ matchConfidence: 'claimed', claimedSlug: 'kid-lightbulbs', name: 'Kid Lightbulbs' })];
    attachArtistPageSlugs(results);

    expect(results[0].claimedSlug).toBe('kid-lightbulbs');
    expect(results[0].knownSlug).toBeUndefined();
  });

  it('leaves an existing knownSlug alone', () => {
    // A stored card already carries the row's real slug, which can differ from what the name
    // would generate if the row was written under an earlier name.
    const results = [result({ knownSlug: 'explosions-in-the-sky-2' })];
    attachArtistPageSlugs(results);

    expect(results[0].knownSlug).toBe('explosions-in-the-sky-2');
  });

  it('skips unverified results, which have no row to point at', () => {
    // persistSearchResults never writes these, so a slug here would 404 in the client.
    const results = [result({ matchConfidence: 'unverified', name: 'Mount Eerie' })];
    attachArtistPageSlugs(results);

    expect(results[0].knownSlug).toBeUndefined();
  });

  it('skips non-artist results', () => {
    const results = [result({ type: 'release' as AggregatedResult['type'], name: 'Some Record' })];
    attachArtistPageSlugs(results);

    expect(results[0].knownSlug).toBeUndefined();
  });

  it('normalizes punctuation and case the same way the persist path does', () => {
    const results = [
      result({ id: 'a', name: 'Godspeed You! Black Emperor' }),
      result({ id: 'b', name: '  Sigur Rós  ' }),
    ];
    attachArtistPageSlugs(results);

    expect(results[0].knownSlug).toBe('godspeed-you-black-emperor');
    // Accents fold rather than collapsing to a separator (they used to give `sigur-r-s`), and
    // leading/trailing separators are trimmed.
    expect(results[1].knownSlug).toBe('sigur-ros');
  });

  it('agrees with artistSlug rather than with a hardcoded string', () => {
    // The assertion above is a readable example; this is the actual invariant. `knownSlug` is used
    // to link a search result at the row `persistSearchResults` wrote, so the two must derive the
    // slug identically — a hand-maintained expected value silently drifts the day artistSlug
    // changes, which is exactly what happened when accent folding landed.
    const names = ['Sigur Rós', 'Björk', 'Błoto', 'Hüsker Dü', 'j:dead', 'girl in red', '  padded  '];
    const results = names.map((name, i) => result({ id: `id-${i}`, name }));
    attachArtistPageSlugs(results);

    for (const [i, name] of names.entries()) {
      expect(results[i].knownSlug).toBe(artistSlug(name));
    }
  });

  it('handles a mixed result set without cross-contamination', () => {
    const results = [
      result({ id: 'a', name: 'Kid Lightbulbs', matchConfidence: 'claimed', claimedSlug: 'kid-lightbulbs' }),
      result({ id: 'b', name: 'Big Thief' }),
      result({ id: 'c', name: 'Nobody Knows', matchConfidence: 'unverified' }),
    ];
    attachArtistPageSlugs(results);

    expect(results.map(r => r.claimedSlug ?? r.knownSlug)).toEqual([
      'kid-lightbulbs',
      'big-thief',
      undefined,
    ]);
  });

  // Three Paracosms in one search. A shared name can't be every one's address, so each gets one
  // that tells it apart — the same one persistSearchResults writes (recordSlugs), so the card's
  // page, Claim and save links all name a row that is theirs.
  describe('cards that share a name', () => {
    const sofia = () => result({ id: 'sofia', name: 'Paracosm', platforms: [{ sourceId: 'bandcamp', url: 'https://paracosm.bandcamp.com' }] });
    const la = () => result({ id: 'la', name: 'paracosm', platforms: [{ sourceId: 'bandcamp', url: 'https://xparacosm.bandcamp.com/' }], location: { city: 'Burbank' } });
    const orlando = () => result({ id: 'orlando', name: 'Paracosm', platforms: [{ sourceId: 'officialsite', url: 'https://paracosmtheband.com/' }], location: { city: 'Orlando', country: 'United States' } });

    it('gives each the address of its Bandcamp account, or its name and city', () => {
      const results = [sofia(), la(), orlando(), result({ id: 'other', name: 'Yung Paracosm' })];
      attachArtistPageSlugs(results);

      expect(results.map(r => r.knownSlug)).toEqual(['paracosm', 'xparacosm', 'paracosm-orlando', 'yung-paracosm']);
    });

    it('gives no slug to a card with nothing to tell it apart', () => {
      const results = [sofia(), result({ id: 'bare', name: 'Paracosm' })];
      attachArtistPageSlugs(results);

      expect(results.map(r => r.knownSlug)).toEqual(['paracosm', undefined]);
    });

    it("keeps a stored row's slug, and gives no one else that address", () => {
      // The stored-artist merge already matched Sofia to the `paracosm` row; a second card that
      // would derive the same address (another `paracosm` Bandcamp is impossible, but a city twin
      // is not) must not be pointed at it.
      const twin = () => result({ id: 'twin', name: 'Paracosm', location: { city: 'Orlando' } });
      const results = [{ ...orlando(), knownSlug: 'paracosm-orlando' }, twin()];
      const slugs = recordSlugs(results);
      attachArtistPageSlugs(results, slugs);

      expect(results.map(r => r.knownSlug)).toEqual(['paracosm-orlando', undefined]);
      expect(slugs.get(results[1])).toBeNull();
    });
  });
});
