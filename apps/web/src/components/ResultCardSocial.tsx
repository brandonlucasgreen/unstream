import { SocialIcon } from './SocialIcon';
import { getSource } from './ResultCardUtils';
import type { PlatformLink } from '../types';
import { analytics } from '../services/analytics';

interface ResultCardSocialProps {
  platforms: PlatformLink[];
  claimedSlug: string | undefined;
}

export function ResultCardSocial({ platforms, claimedSlug }: ResultCardSocialProps) {
  if (platforms.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
        Social
      </h4>
      <div className="flex flex-wrap gap-3">
        {platforms.map(platform => (
          <a
            key={platform.sourceId}
            href={platform.url}
            target="_blank"
            rel="noopener noreferrer"
            className="w-8 h-8 flex items-center justify-center rounded-full bg-bg-secondary hover:bg-bg-tertiary transition-colors"
            title={platform.displayName ?? getSource(platform.sourceId).name}
            onClick={(e) => {
              e.stopPropagation();
              analytics.trackPlatformClick(platform.displayName ?? getSource(platform.sourceId).name);
              if (claimedSlug) analytics.trackArtistLinkClick(claimedSlug, platform.sourceId);
            }}
          >
            <SocialIcon platform={platform.sourceId} />
          </a>
        ))}
      </div>
    </div>
  );
}
