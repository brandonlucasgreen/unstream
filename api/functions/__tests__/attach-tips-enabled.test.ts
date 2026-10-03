// Search results pick up the Tip button by page slug.

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
    attachTipsEnabled([claimed, known, none], new Set(['a', 'b']));
    expect(claimed.tipsEnabled).toBe(true);
    expect(known.tipsEnabled).toBe(true);
    expect(none).not.toHaveProperty('tipsEnabled');
  });

  it('leaves results alone when the read failed or nobody takes tips', () => {
    const r = result({ claimedSlug: 'a' });
    attachTipsEnabled([r], null);
    attachTipsEnabled([r], new Set());
    expect(r).not.toHaveProperty('tipsEnabled');
  });
});
