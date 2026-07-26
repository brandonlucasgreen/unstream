import { describe, it, expect } from 'vitest';

// The bug this guards: `bandcamp_slug_probes.query_norm` is
// normalizeForComparison(query), which strips punctuation — but punctuation is exactly
// what produces the extra slug candidate. So "Morice" and "Mo-Rice" share one cache row
// while probing different slugs:
//
//   "Morice"  -> candidates ['morice']              -> 404 -> verdict 'absent'
//   "Mo-Rice" -> candidates ['morice', 'mo-rice']   -> 'mo-rice' is a live account
//
// Reusing the first row for the second query hid a real artist with 16 releases.
// A negative is only reusable when it covers every candidate the query would try.

import { negativeCoversCandidates } from '../db';
import { bandcampSlugCandidates } from '../search-utils';

describe('negativeCoversCandidates', () => {
  it('reuses a negative that covers every candidate', () => {
    expect(negativeCoversCandidates(['morice'], ['morice'])).toBe(true);
    expect(negativeCoversCandidates(['morice', 'mo-rice'], ['morice', 'mo-rice'])).toBe(true);
  });

  it('reuses a negative that probed more than the query needs', () => {
    expect(negativeCoversCandidates(['morice', 'mo-rice'], ['morice'])).toBe(true);
  });

  it('rejects a negative that never tried one of the candidates', () => {
    // The actual Mo-Rice bug.
    expect(negativeCoversCandidates(['morice'], ['morice', 'mo-rice'])).toBe(false);
  });

  it('rejects a legacy row with unknown coverage', () => {
    // Pre-migration rows have NULL probed_slugs — unknown, so re-probe once.
    expect(negativeCoversCandidates(null, ['morice'])).toBe(false);
  });

  it('rejects a row that recorded no attempts at all', () => {
    expect(negativeCoversCandidates([], ['morice'])).toBe(false);
  });

  it('treats an empty candidate list as covered, so callers can opt out', () => {
    expect(negativeCoversCandidates(null, [])).toBe(false);
    expect(negativeCoversCandidates(['morice'], [])).toBe(true);
  });
});

describe('the Mo-Rice collision, end to end through the candidate generator', () => {
  it('gives the two spellings different candidate sets', () => {
    expect(bandcampSlugCandidates('Morice')).toEqual(['morice']);
    expect(bandcampSlugCandidates('Mo-Rice')).toEqual(['morice', 'mo-rice']);
  });

  it("does not let the misspelling's negative answer for the real name", () => {
    const probedForMisspelling = bandcampSlugCandidates('Morice');
    const neededForRealName = bandcampSlugCandidates('Mo-Rice');

    expect(negativeCoversCandidates(probedForMisspelling, neededForRealName)).toBe(false);
    // ...while the reverse direction is safe to reuse.
    expect(negativeCoversCandidates(neededForRealName, probedForMisspelling)).toBe(true);
  });

  it('holds for other punctuated names, e.g. Ben-G!', () => {
    expect(bandcampSlugCandidates('Ben-G!')).toEqual(['beng', 'ben-g']);
    expect(negativeCoversCandidates(['beng'], bandcampSlugCandidates('Ben-G!'))).toBe(false);
  });

  it('leaves single-token names unaffected, so their cache still hits', () => {
    const candidates = bandcampSlugCandidates('Radiohead');
    expect(candidates).toEqual(['radiohead']);
    expect(negativeCoversCandidates(['radiohead'], candidates)).toBe(true);
  });
});
