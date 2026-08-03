import { describe, it, expect } from 'vitest';
import { attachArtistPageSlugs } from '../search-sources';
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
});
