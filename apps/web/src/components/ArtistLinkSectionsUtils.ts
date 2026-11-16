import type { ArtistPagePayload } from '../types/artist-page';
import { sources } from '../services/sources';
import { groupLinksIntoSections, type PageSectionKey } from '../../../../api/shared/page-sections';
import { mainLinkDividerIndexes } from '../../../../api/shared/link-dividers';
import type { SourceId } from '../types';

// What the artist page's link sections (ArtistLinkSections.tsx) are built from: the headings and
// the grouping. Kept out of that file so it exports only components.

export type ArtistPageLinkGroup = NonNullable<ArtistPagePayload['linkGroups']>[number];

/** Section headings as the artist page shows them (edit-page labels match these). */
export const SECTION_HEADINGS: Record<PageSectionKey, string> = {
  patronage: 'Patronage',
  bio: 'Bio',
  featured: 'Featured Release',
  marketplaces: 'Marketplaces',
  official: 'Official',
  social: 'Follow',
};

/**
 * The payload's links by section. Server-grouped when the payload carries them. A cached
 * response predating the section payload has only the legacy flat fields — derive the same
 * groups client-side from the web copy of the registry (the same sectionCategory values,
 * parity-tested), so the page renders identically during a CDN cache roll.
 *
 * The legacy divider positions ("a rule above flat-index N of the main list") are translated
 * into per-section rule indexes the same way the server does: mainLinkDividerIndexes against
 * the full stored order, then the links whose *pre-divider* count matches a rule carry that
 * rule into their section.
 */
export function resolveLinkGroups(payload: ArtistPagePayload): Map<PageSectionKey, ArtistPageLinkGroup> {
  const { links, socialLinks } = payload;
  const flatLinks = [
    ...links,
    ...socialLinks.map(l => ({ ...l, payoutPercent: null, bandcampFriday: false })),
  ];
  // Dividers only ever landed on main-list gaps; socials render as their own section, so
  // social-only rule positions are intentionally unreachable (see api/shared/link-dividers.ts).
  const legacyRuleFlatIndexes = new Set<number>();
  if (!payload.linkGroups && payload.linkDividers?.length) {
    // mainLinkDividerIndexes counts stored positions against the FULL link list it is given
    // (socials included) — that is the list the editor's stored positions were written
    // against. Feed it the same full flat order, then drop every rule it lands on a social
    // (those move to the Follow section, not a rule inside the main sections).
    const isMainLink = (l: (typeof flatLinks)[number]) =>
      sources[l.platform as SourceId]?.sectionCategory !== 'social';
    const mainRulePreCounts = new Set(
      mainLinkDividerIndexes(flatLinks, isMainLink, payload.linkDividers),
    );
    let mainCount = 0;
    flatLinks.forEach((link, flatIndex) => {
      if (mainRulePreCounts.has(mainCount) && isMainLink(link)) {
        legacyRuleFlatIndexes.add(flatIndex);
      }
      mainCount++;
    });
  }

  const rawGroups = payload.linkGroups ?? groupLinksIntoSections(
    flatLinks.map((link, flatIndex) => ({ ...link, __flatIndex: flatIndex })),
    link => sources[link.platform as SourceId]?.sectionCategory,
    [],
  ).map(group => ({
    section: group.key as ArtistPageLinkGroup['section'],
    links: group.items.map((item) => {
      const { __flatIndex, ...rest } = item as { __flatIndex: number } & Record<string, unknown>;
      void __flatIndex;
      return rest as unknown as ArtistPageLinkGroup['links'][number];
    }),
    dividerIndexes: group.items
      .map((item, positionInGroup) =>
        legacyRuleFlatIndexes.has((item as { __flatIndex: number }).__flatIndex)
          ? positionInGroup
          : -1)
      .filter(n => n >= 0),
  }));
  return new Map(
    rawGroups.map(g => [g.section as PageSectionKey, g as ArtistPageLinkGroup]),
  );
}
