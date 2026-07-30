import { describe, it, expect } from 'vitest';
import { mainLinkDividerIndexes, buildLinkRows, MAX_DIVIDERS } from '../../shared/link-dividers';

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

// buildLinkRows turns the editor's single ordered list into what gets stored.
// It feeds replace_artist_links, so a mistake here rewrites an artist's page.
const entry = (platform: string, url = `https://${platform}.example`) => ({ platform, url });
const divider = { platform: 'divider' };

describe('buildLinkRows', () => {
  it('stores links in submitted order and keeps dividers out of the rows', () => {
    const { links, dividers } = buildLinkRows([entry('bandcamp'), divider, entry('patreon')]);
    expect(links.map(l => l.platform)).toEqual(['bandcamp', 'patreon']);
    expect(links.map(l => l.display_order)).toEqual([0, 1]);
    expect(dividers).toEqual([1]);
  });

  it('gives each "other" link a unique platform id', () => {
    // artist_links has unique(artist_id, platform), so two bare "other" rows
    // would abort the whole save.
    const { links } = buildLinkRows([entry('other'), entry('bandcamp'), entry('other')]);
    expect(links.map(l => l.platform)).toEqual(['other_0', 'bandcamp', 'other_1']);
  });

  it('trims and truncates a display name, and stores a blank one as null', () => {
    const { links } = buildLinkRows([
      { platform: 'other', url: 'https://a.example', displayName: `  ${'x'.repeat(80)}  ` },
      { platform: 'other', url: 'https://b.example', displayName: '   ' },
    ]);
    expect(links[0].display_name).toBe('x'.repeat(50));
    expect(links[1].display_name).toBeNull();
  });

  it('drops leading, trailing, and repeated dividers', () => {
    expect(buildLinkRows([divider, entry('bandcamp')]).dividers).toEqual([]);
    expect(buildLinkRows([entry('bandcamp'), divider]).dividers).toEqual([]);
    expect(buildLinkRows([entry('bandcamp'), divider, divider, entry('mirlo')]).dividers).toEqual([1]);
  });

  it('caps dividers so a runaway payload cannot balloon the stored array', () => {
    const entries = [entry('p0')];
    for (let i = 1; i <= MAX_DIVIDERS + 5; i++) {
      entries.push(divider, entry(`p${i}`));
    }
    expect(buildLinkRows(entries).dividers).toHaveLength(MAX_DIVIDERS);
  });

  it('returns an empty set when the artist removed every link', () => {
    // The caller still runs the replace, which is how a full clear is saved.
    expect(buildLinkRows([])).toEqual({ links: [], dividers: [] });
  });

  it('drops a divider that only had links removed from one side', () => {
    // Everything after the divider was invalid and filtered out upstream, so the
    // position now equals the link count — a rule with nothing under it.
    expect(buildLinkRows([entry('bandcamp'), entry('mirlo'), divider]).dividers).toEqual([]);
  });
});
