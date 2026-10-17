// api/shared/page-sections.ts — the UNS-221 section model. Pure functions, node environment.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SECTION_ORDER,
  normalizeSectionOrder,
  resolveSectionOrder,
  linkSectionForCategory,
  groupLinksIntoSections,
} from '../../../../api/shared/page-sections';

describe('normalizeSectionOrder', () => {
  it('returns null for absent/empty/invalid input', () => {
    expect(normalizeSectionOrder(null)).toBeNull();
    expect(normalizeSectionOrder(undefined)).toBeNull();
    expect(normalizeSectionOrder('patronage')).toBeNull();
    expect(normalizeSectionOrder({})).toBeNull();
  });

  it('accepts a full reorder and preserves it', () => {
    expect(
      normalizeSectionOrder(['bio', 'featured', 'social', 'marketplaces', 'patronage']),
    ).toEqual(['bio', 'featured', 'social', 'marketplaces', 'patronage']);
  });

  it('drops duplicates and unknown keys, re-appends omissions in default order', () => {
    expect(normalizeSectionOrder(['bio', 'nope', 'bio', 'featured'])).toEqual([
      'bio',
      'featured',
      'patronage',
      'marketplaces',
      'social',
    ]);
  });

  it('an edit-page bug can never hide a section (omissions re-appended)', () => {
    expect(normalizeSectionOrder(['featured'])).toEqual([
      'featured',
      'bio',
      'patronage',
      'marketplaces',
      'social',
    ]);
  });
});

describe('resolveSectionOrder', () => {
  it('defaults to bio first when nothing stored (UNS-221 default order)', () => {
    expect(resolveSectionOrder(null)).toEqual([...DEFAULT_SECTION_ORDER]);
    expect(DEFAULT_SECTION_ORDER[0]).toBe('bio');
    expect(DEFAULT_SECTION_ORDER[2]).toBe('patronage');
  });

  it('applies the stored order when present', () => {
    expect(resolveSectionOrder(['social', 'bio'])).toEqual([
      'social',
      'bio',
      'featured',
      'patronage',
      'marketplaces',
    ]);
  });
});

describe('linkSectionForCategory', () => {
  it('patronage / official / social are their own sections', () => {
    expect(linkSectionForCategory('patronage')).toBe('patronage');
    expect(linkSectionForCategory('official')).toBe('official');
    expect(linkSectionForCategory('social')).toBe('social');
  });

  it('everything else (marketplace, library, decentralized, curated, unknown) rides in marketplaces', () => {
    expect(linkSectionForCategory('marketplace')).toBe('marketplaces');
    expect(linkSectionForCategory('library')).toBe('marketplaces');
    expect(linkSectionForCategory('decentralized')).toBe('marketplaces');
    expect(linkSectionForCategory('curated')).toBe('marketplaces');
    expect(linkSectionForCategory(undefined)).toBe('marketplaces');
  });
});

describe('groupLinksIntoSections', () => {
  const cat = (p: string): string | undefined =>
    ({
      patreon: 'patronage',
      kofi: 'patronage',
      bandcamp: 'marketplaces',
      faircamp: 'official',
      newsletter: 'official',
      instagram: 'social',
      hoopla: 'library',
    })[p];

  it('groups links by section, preserving stored order inside each', () => {
    const groups = groupLinksIntoSections(
      [
        { platform: 'bandcamp' },
        { platform: 'patreon' },
        { platform: 'instagram' },
        { platform: 'faircamp' },
        { platform: 'newsletter' },
      ],
      (l: { platform: string }) => cat(l.platform),
      [],
    );
    expect(groups.map(g => g.key)).toEqual(['patronage', 'marketplaces', 'social', 'official']);
    expect(groups.find(g => g.key === 'official')?.items).toHaveLength(2);
  });

  it('an unknown platform rides in marketplaces, never dropped', () => {
    const groups = groupLinksIntoSections(
      [{ platform: 'some_new_platform_we_have_not_added' }],
      (l: { platform: string }) => cat(l.platform),
      [],
    );
    expect(groups.map(g => g.key)).toEqual(['marketplaces']);
    expect(groups[0].items).toHaveLength(1);
  });

  it('translates whole-list divider positions into per-section rule indexes', () => {
    // Two patronage links with the artist's rule between them (stored before whole-list
    // index 1, the 2nd link). Within patronage that is a rule above position 1 (Ko-fi).
    const groups = groupLinksIntoSections(
      [{ platform: 'patreon' }, { platform: 'kofi', url: 'x' }, { platform: 'bandcamp' }],
      (l: { platform: string }) => cat(l.platform),
      [1],
    );
    const patronage = groups.find(g => g.key === 'patronage');
    expect(patronage?.ruleIndexes).toEqual([1]);
    expect(groups.find(g => g.key === 'marketplaces')?.ruleIndexes).toEqual([]);
  });

  it('drops a divider at a section boundary (the section gap IS the separator)', () => {
    const groups = groupLinksIntoSections(
      [{ platform: 'bandcamp' }, { platform: 'patreon' }],
      (l: { platform: string }) => cat(l.platform),
      [1],
    );
    // No rule inside either section — the headings separate them.
    expect(groups.every(g => g.ruleIndexes.length === 0)).toBe(true);
    // Both links still present.
    expect(groups.map(g => g.items.length)).toEqual([1, 1]);
  });

  it('empty sections are omitted from the result', () => {
    const groups = groupLinksIntoSections(
      [{ platform: 'bandcamp' }],
      (l: { platform: string }) => cat(l.platform),
      [],
    );
    expect(groups.map(g => g.key)).toEqual(['marketplaces']);
  });
});