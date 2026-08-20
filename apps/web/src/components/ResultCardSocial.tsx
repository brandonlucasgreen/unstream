import { SocialIcon } from './SocialIcon';
import { getSource } from './ResultCardUtils';
import type { PlatformLink } from '../types';
import { analytics } from '../services/analytics';

interface ResultCardSocialProps {
  platforms: PlatformLink[];
  claimedSlug: string | undefined;
  /** Admin-only: when set, each icon gets a remove control. */
  onRemoveLink?: (platform: PlatformLink) => void;
}

export function ResultCardSocial({ platforms, claimedSlug, onRemoveLink }: ResultCardSocialProps) {
  if (platforms.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
        Social
      </h4>
      <div className="flex flex-wrap gap-3">
        {platforms.map(platform => (
          <span key={platform.sourceId} className="inline-flex items-center gap-1">
          <a
            href={platform.url}
            target="_blank"
            rel="noopener noreferrer"
            className="w-8 h-8 flex items-center justify-center rounded-full bg-bg-secondary hover:bg-bg-tertiary transition-colors"
            title={platform.displayName ?? getSource(platform.sourceId).name}
            onClick={(e) => {
              e.stopPropagation();
              // One tracker per click: trackArtistLinkClick already records the platform_click
              // product event, so also calling trackPlatformClick double-counted claimed clicks.
              if (claimedSlug) analytics.trackArtistLinkClick(claimedSlug, platform.sourceId);
              else analytics.trackPlatformClick(platform.displayName ?? getSource(platform.sourceId).name);
            }}
          >
            <SocialIcon platform={platform.sourceId} />
          </a>
          {onRemoveLink && (
            <button
              onClick={() => onRemoveLink(platform)}
              className="text-text-muted hover:text-red-400 transition-colors"
              title="Remove this link (admin)"
              aria-label={`Remove the ${getSource(platform.sourceId).name} link`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          </span>
        ))}
      </div>
    </div>
  );
}
