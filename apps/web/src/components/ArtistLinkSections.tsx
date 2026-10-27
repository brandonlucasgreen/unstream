import { Fragment } from 'react';
import type { ArtistPagePayload } from '../types/artist-page';
import { sources } from '../services/sources';
import { groupLinksIntoSections, type PageSectionKey } from '../../../../api/shared/page-sections';
import { mainLinkDividerIndexes } from '../../../../api/shared/link-dividers';
import { SocialIcon } from './SocialIcon';
import { SourceBadge } from './SourceBadge';
import { getSource } from './ResultCardUtils';
import type { SourceId } from '../types';

// The artist page's link sections (UNS-221), shared by the claimed page (RichArtistProfile) and
// the unclaimed one (UnclaimedQuietCard), so every artist page groups its links the same way:
// Patronage, Marketplaces, Official, Follow.

type ArtistLink = ArtistPagePayload['links'][number];
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

/**
 * One section's pills, split at the artist's own divider positions into wrapped rows
 * with a rule between rows — the arrangement they set for those links.
 */
export function SectionPillGroups({ group, handleLinkClick }: {
  group: ArtistPageLinkGroup;
  handleLinkClick: (platform: string) => void;
}) {
  const dividerIndexes = new Set(group.dividerIndexes ?? []);
  const groups: ArtistLink[][] = [];
  let current: ArtistLink[] = [];

  group.links.forEach((link, index) => {
    if (dividerIndexes.has(index) && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(link);
  });
  if (current.length > 0) groups.push(current);

  return (
    <div className="space-y-3">
      {groups.map((rows, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && <hr className="border-0 border-t border-border" />}
          <div className="platform-pill-row">
            {rows.map(link => {
              const badge = (
                <SourceBadge
                  source={getSource(link.platform as SourceId)}
                  url={link.url}
                  isDirectLink
                  displayName={link.displayName ?? undefined}
                  onClick={() => handleLinkClick(link.platform)}
                />
              );
              const key = link.platform + link.url;

              // The Bandcamp Friday label rides along in the same cell, so the
              // pill row stays one grid cell per platform on a phone.
              if (!link.bandcampFriday) return <Fragment key={key}>{badge}</Fragment>;
              return (
                <span key={key} className="flex items-center gap-2">
                  {badge}
                  <span className="bandcamp-friday-label">Bandcamp Friday!</span>
                </span>
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** The Follow section's social links: quieter outlined chips rather than platform pills. */
export function FollowLinks({ group, handleLinkClick }: {
  group: ArtistPageLinkGroup;
  handleLinkClick: (platform: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {group.links.map(link => {
        const source = sources[link.platform as SourceId];
        const linkName = link.displayName || source?.name || link.platform;

        return (
          <a
            key={link.platform + link.url}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            data-track-platform={link.platform}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-hover transition-colors"
            onClick={() => handleLinkClick(link.platform)}
          >
            <SocialIcon platform={link.platform} className="w-4 h-4" />
            {linkName}
          </a>
        );
      })}
    </div>
  );
}
