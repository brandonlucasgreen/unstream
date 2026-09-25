// The extension popup shows at most eight of an artist's platforms. It used to take the first
// eight in result order, so an artist with a long row of stores could lose their Patreon or
// Ko-fi link — the exact click the tips demand test (docs/specs/artist-tips-spec.md §9 Phase 0)
// is counting.

import { describe, it, expect } from 'vitest';
import { PLATFORMS } from '../../../../api/shared/platform-registry';
import {
  PATRONAGE_SOURCE_IDS,
  pickVisiblePlatforms,
} from '../../../../apps/extension/lib/popup-platforms.js';

const ids = (platforms: { sourceId: string }[]) => platforms.map(p => p.sourceId);
const make = (...sourceIds: string[]) => sourceIds.map(sourceId => ({ sourceId, url: `https://example.com/${sourceId}` }));

describe('the extension’s patronage list matches the platform registry', () => {
  it('holds exactly the registry’s patronage-category ids', () => {
    const registry = Object.entries(PLATFORMS)
      .filter(([, meta]) => meta.category === 'patronage')
      .map(([id]) => id);
    expect([...PATRONAGE_SOURCE_IDS].sort()).toEqual(registry.sort());
  });
});

describe('pickVisiblePlatforms', () => {
  it('leaves a short list alone', () => {
    const platforms = make('bandcamp', 'kofi', 'mirlo');
    expect(ids(pickVisiblePlatforms(platforms, 8))).toEqual(['bandcamp', 'kofi', 'mirlo']);
  });

  it('keeps patronage links that fall past the cap, dropping the last stores instead', () => {
    const platforms = make(
      'bandcamp', 'mirlo', 'ampwall', 'faircamp', 'jamcoop', 'discogs', 'qobuz', 'officialsite',
      'beatport', 'patreon', 'liberapay',
    );
    expect(ids(pickVisiblePlatforms(platforms, 8))).toEqual([
      'bandcamp', 'mirlo', 'ampwall', 'faircamp', 'jamcoop', 'discogs', 'patreon', 'liberapay',
    ]);
  });

  it('keeps the original order rather than moving patronage to the front', () => {
    const platforms = make('bandcamp', 'patreon', 'mirlo', 'ampwall', 'faircamp', 'kofi');
    expect(ids(pickVisiblePlatforms(platforms, 4))).toEqual(['bandcamp', 'patreon', 'mirlo', 'kofi']);
  });

  it('never shows more than the limit', () => {
    const platforms = make('patreon', 'kofi', 'buymeacoffee', 'liberapay', 'bandcamp');
    expect(ids(pickVisiblePlatforms(platforms, 3))).toEqual(['patreon', 'kofi', 'buymeacoffee']);
  });
});
