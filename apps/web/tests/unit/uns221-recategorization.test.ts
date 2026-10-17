// UNS-221 recategorization pinned on the search-results side: Newsletter, Faircamp and
// Official Site are OFFICIAL (not social / not decentralized), so the ResultCard renders
// them in the Official section. Guarded by the registry parity test too — this file pins
// the user-visible grouping, that one pins the data copies.

import { describe, it, expect } from 'vitest';
import { sourceCategories } from '../../src/services/sources';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import { categorizePlatforms, allKnownSourceIds } from '../../src/components/ResultCardUtils';
import type { PlatformLink } from '../../src/types';

const link = (sourceId: string, url: string): PlatformLink =>
  ({ sourceId: sourceId as PlatformLink['sourceId'], url });

describe('UNS-221 search-result sections', () => {
  it('groups Newsletter into official, not social', () => {
    const result = categorizePlatforms(
      [link('newsletter', 'https://buttondown.email/kid')],
      allKnownSourceIds,
    );
    expect(result.official.map(p => p.sourceId)).toContain('newsletter');
    expect(result.social.map(p => p.sourceId)).not.toContain('newsletter');
  });

  it('groups Faircamp into official, not decentralized', () => {
    const result = categorizePlatforms(
      [link('faircamp', 'https://kid.faircamp.site')],
      allKnownSourceIds,
    );
    expect(result.official.map(p => p.sourceId)).toContain('faircamp');
    expect(result.decentralized.map(p => p.sourceId)).not.toContain('faircamp');
  });

  it('keeps Official Site itself official (already was — pinned)', () => {
    const result = categorizePlatforms(
      [link('officialsite', 'https://kidlightbulbs.com')],
      allKnownSourceIds,
    );
    expect(result.official.map(p => p.sourceId)).toContain('officialsite');
  });

  it('the registry agrees with the web copy on all three', () => {
    for (const id of ['newsletter', 'faircamp', 'officialsite']) {
      expect(PLATFORMS[id].category).toBe('official');
      expect(sourceCategories.official.sources as string[]).toContain(id);
      // Newsletter and Faircamp changed; official site never moved.
      if (id !== 'officialsite') {
        expect(
          (sourceCategories.social.sources as string[]).includes(id) ||
            (sourceCategories.decentralized.sources as string[]).includes(id),
        ).toBe(false);
      }
    }
  });

  it('every section key the artist page defines has a category bucket that feeds it', () => {
    // The section model (api/shared/page-sections.ts) maps registry category -> section;
    // a category with no bucket would silently strand a platform's links on search results.
    const bucketKeys = Object.keys(sourceCategories);
    for (const key of Object.values(PLATFORMS).map(p => p.category)) {
      expect(bucketKeys).toContain(key);
    }
  });
});