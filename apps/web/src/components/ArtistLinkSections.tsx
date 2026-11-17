import { Fragment, type ReactNode } from 'react';
import type { ArtistPagePayload } from '../types/artist-page';
import { sources } from '../services/sources';
import { SocialIcon } from './SocialIcon';
import { SourceBadge } from './SourceBadge';
import { getSource } from './ResultCardUtils';
import type { ArtistPageLinkGroup } from './ArtistLinkSectionsUtils';
import type { SourceId } from '../types';

// The artist page's link sections (UNS-221), shared by the claimed page (RichArtistProfile) and
// the unclaimed one (UnclaimedQuietCard), so every artist page groups its links the same way:
// Patronage, Marketplaces, Official, Follow.

type ArtistLink = ArtistPagePayload['links'][number];

/**
 * One section's pills, split at the artist's own divider positions into wrapped rows
 * with a rule between rows — the arrangement they set for those links.
 */
export function SectionPillGroups({ group, handleLinkClick, leading }: {
  group: ArtistPageLinkGroup;
  handleLinkClick: (platform: string) => void;
  /** A pill that opens the first row, ahead of the links (the Patronage section's Tip button). */
  leading?: ReactNode;
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
            {groupIndex === 0 && leading}
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
