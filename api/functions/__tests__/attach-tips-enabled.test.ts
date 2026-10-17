// Search results pick up the Tip button by page slug — and only while the tips flag is on
// (UNS-215): the flag is the admin-only rollout switch, so a result must not carry `tipsEnabled`
// for any other reason.

import { describe, it, expect } from 'vitest';
import { attachTipsEnabled, type AggregatedResult } from '../search-utils';

const result = (overrides: Partial<AggregatedResult>): AggregatedResult => ({
  id: 'x', name: 'X', type: 'artist', platforms: [], ...overrides,
});

describe('attachTipsEnabled', () => {
  it('flags only results whose page slug is taking tips, claimed or known', () => {
    const claimed = result({ claimedSlug: 'a' });
    const known = result({ knownSlug: 'b' });
    const none = result({});
    attachTipsEnabled([claimed, known, none], new Set(['a', 'b']), true);
    expect(claimed.tipsEnabled).toBe(true);
    expect(known.tipsEnabled).toBe(true);
    expect(none).not.toHaveProperty('tipsEnabled');
  });

  it('leaves results alone when the read failed or nobody takes tips', () => {
    const r = result({ claimedSlug: 'a' });
    attachTipsEnabled([r], null, true);
    attachTipsEnabled([r], new Set(), true);
    expect(r).not.toHaveProperty('tipsEnabled');
  });

  it('marks nothing while the tips flag is off, even for a live slug set', () => {
    // The gate is on the flag, not on the data: whether or not these slugs can take tips, a
    // flag-off rollout leaves every card without a Tip button.
    const r = result({ claimedSlug: 'a' });
    const known = result({ knownSlug: 'b' });
    attachTipsEnabled([r, known], new Set(['a', 'b']), false);
    expect(r).not.toHaveProperty('tipsEnabled');
    expect(known).not.toHaveProperty('tipsEnabled');
  });

  it('marks nothing while the flag is off and the read also failed', () => {
    const r = result({ claimedSlug: 'a' });
    attachTipsEnabled([r], null, false);
    expect(r).not.toHaveProperty('tipsEnabled');
  });
});
