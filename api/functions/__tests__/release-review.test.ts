// Folding a flat needs_review result set into pairs for the admin review queue.
//
// The property worth locking: a symmetric flag (A points at B, B points at A) must produce one
// pair to review, not two — an admin re-deciding the same pair twice under two different rows
// is the failure mode here.

import { describe, it, expect } from 'vitest';
import { pairReviewRows, type ReleaseReviewItem } from '../db';

function item(id: string, overrides: Partial<ReleaseReviewItem> = {}): ReleaseReviewItem {
  return {
    id,
    title: `Release ${id}`,
    slug: `release-${id}`,
    releaseType: 'album',
    releaseDate: null,
    datePrecision: null,
    artworkUrl: null,
    artistName: 'Some Artist',
    artistSlug: 'some-artist',
    platforms: ['bandcamp'],
    ...overrides,
  };
}

describe('pairReviewRows', () => {
  it('collapses a symmetric pair into one entry', () => {
    const rows = new Map([
      ['a', { ...item('a'), flaggedAgainst: 'b' }],
      ['b', { ...item('b'), flaggedAgainst: 'a' }],
    ]);

    const pairs = pairReviewRows(rows);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].primary.id, pairs[0].counterpart?.id]).toEqual(['a', 'b']);
  });

  it('shows a row alone when its counterpart is not in the flagged set', () => {
    const rows = new Map([['a', { ...item('a'), flaggedAgainst: 'ghost' }]]);

    const pairs = pairReviewRows(rows);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].primary.id).toBe('a');
    expect(pairs[0].counterpart).toBeNull();
  });

  it('shows a row with no flag target at all as an unpaired entry', () => {
    const rows = new Map([['a', { ...item('a'), flaggedAgainst: null }]]);

    const pairs = pairReviewRows(rows);
    expect(pairs).toEqual([{ primary: rows.get('a'), counterpart: null }]);
  });

  it('handles multiple independent pairs for different artists', () => {
    const rows = new Map([
      ['a', { ...item('a'), flaggedAgainst: 'b' }],
      ['b', { ...item('b'), flaggedAgainst: 'a' }],
      ['c', { ...item('c', { artistName: 'Other Artist' }), flaggedAgainst: 'd' }],
      ['d', { ...item('d', { artistName: 'Other Artist' }), flaggedAgainst: 'c' }],
    ]);

    const pairs = pairReviewRows(rows);
    expect(pairs).toHaveLength(2);
  });
});
