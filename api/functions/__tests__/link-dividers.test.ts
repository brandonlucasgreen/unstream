import { describe, it, expect } from 'vitest';
import { mainLinkDividerIndexes } from '../../shared/link-dividers';

// The artist page splits links into "Support directly" (main) and "Follow"
// (social), but divider positions are stored against the full link order — so
// the translation is what these tests care about.
const link = (platform: string) => ({ platform });
const isMain = (l: { platform: string }) => l.platform !== 'instagram';

describe('mainLinkDividerIndexes', () => {
  it('returns nothing when the artist placed no dividers', () => {
    const links = [link('bandcamp'), link('patreon')];
    expect(mainLinkDividerIndexes(links, isMain, null)).toEqual([]);
    expect(mainLinkDividerIndexes(links, isMain, [])).toEqual([]);
  });

  it('maps a position to the main link it sits above', () => {
    const links = [link('bandcamp'), link('mirlo'), link('patreon')];
    expect(mainLinkDividerIndexes(links, isMain, [2])).toEqual([2]);
  });

  it('shifts past social links, which render in their own section', () => {
    // instagram is stored second, so the divider at position 2 sits above the
    // third stored link — the second *main* link.
    const links = [link('bandcamp'), link('instagram'), link('patreon')];
    expect(mainLinkDividerIndexes(links, isMain, [2])).toEqual([1]);
  });

  it('drops a leading divider', () => {
    const links = [link('bandcamp'), link('patreon')];
    expect(mainLinkDividerIndexes(links, isMain, [0])).toEqual([]);
  });

  it('drops a trailing divider', () => {
    const links = [link('bandcamp'), link('patreon')];
    expect(mainLinkDividerIndexes(links, isMain, [2])).toEqual([]);
  });

  it('collapses repeated dividers in the same gap', () => {
    const links = [link('bandcamp'), link('instagram'), link('patreon')];
    expect(mainLinkDividerIndexes(links, isMain, [1, 2])).toEqual([1]);
  });

  it('handles several dividers in order', () => {
    const links = [link('bandcamp'), link('mirlo'), link('patreon'), link('ko-fi')];
    expect(mainLinkDividerIndexes(links, isMain, [1, 3])).toEqual([1, 3]);
  });
});
