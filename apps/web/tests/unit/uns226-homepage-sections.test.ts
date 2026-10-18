// UNS-226: the homepage "Available sources" grid. The empty "Self-hosted & Decentralized"
// block (Faircamp went official in UNS-221; funkwhale is enrichment-only) is replaced by
// "Official & Self-Hosted", which renders the official category. These pins cover the
// exported HOMEPAGE_SOURCE_CATEGORIES list and the buckets behind it — App.tsx consumes
// exactly that list, so the grid can't drift from it silently.

import { describe, it, expect } from 'vitest';
import { HOMEPAGE_SOURCE_CATEGORIES, sourceCategories, sources } from '../../src/services/sources';
import { CATEGORY_ORDER } from '../../../../api/shared/platform-registry';

describe('UNS-226 homepage grid', () => {
  it('renders marketplace, patronage, official and library — in that order', () => {
    expect(HOMEPAGE_SOURCE_CATEGORIES).toEqual(['marketplace', 'patronage', 'official', 'library']);
  });

  it('no longer renders the empty decentralized bucket', () => {
    expect(HOMEPAGE_SOURCE_CATEGORIES).not.toContain('decentralized');
    // The bucket itself still exists (funkwhale's future), it just has nobody searchable.
    expect(sourceCategories.decentralized.sources).toHaveLength(0);
  });

  it('the official section carries the combined title, mirrored in the registry', () => {
    expect(sourceCategories.official.name).toBe('Official & Self-Hosted');
    expect(CATEGORY_ORDER.find((c) => c.key === 'official')?.name).toBe('Official & Self-Hosted');
  });

  it("every homepage bucket has at least one linkable chip — a cell can't render empty", () => {
    for (const key of HOMEPAGE_SOURCE_CATEGORIES) {
      const linkable = sourceCategories[key].sources.filter(
        (id) => /^https:\/\//.test(sources[id].homepageUrl),
      );
      expect(linkable.length, key).toBeGreaterThanOrEqual(1);
    }
  });

  it('official keeps faircamp, so the self-hosted half of the title is real', () => {
    expect(sourceCategories.official.sources as string[]).toContain('faircamp');
  });
});