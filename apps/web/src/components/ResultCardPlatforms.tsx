import { SourceBadge } from './SourceBadge';
import { getSource, isDirectLink } from './ResultCardUtils';
import type { PlatformLink } from '../types';
import { useState } from 'react';

interface ResultCardPlatformsProps {
  platforms: PlatformLink[];
  category: string;
  compact?: boolean;
  /** Admin-only: when set, each badge gets a remove control. */
  onRemoveLink?: (platform: PlatformLink) => void;
}

function PlatformBadge({ platform, onRemoveLink }: { platform: PlatformLink; onRemoveLink?: (platform: PlatformLink) => void }) {
  const badge = (
    <SourceBadge
      source={getSource(platform.sourceId)}
      url={platform.url}
      isDirectLink={isDirectLink(platform.url, platform.sourceId)}
      displayName={platform.displayName}
    />
  );

  if (!onRemoveLink) return badge;

  return (
    <span className="inline-flex items-center gap-1">
      {badge}
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
    </span>
  );
}

export function ResultCardPlatforms({ platforms, category, compact = false, onRemoveLink }: ResultCardPlatformsProps) {
  const [showAll, setShowAll] = useState(false);

  // If compact mode, limit to 4 platforms, otherwise show all
  const visiblePlatforms = compact && platforms.length > 4
    ? platforms.slice(0, 4)
    : platforms;
  const hasMore = compact && platforms.length > 4;

  if (platforms.length === 0) return null;

  return (
    <div className="space-y-2">
      {category !== 'Support this artist' && (
        <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {category}
        </h4>
      )}
      <div className="platform-pill-row">
        {visiblePlatforms.map(platform => (
          <PlatformBadge key={platform.sourceId} platform={platform} onRemoveLink={onRemoveLink} />
        ))}
      </div>
      {hasMore && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="text-xs text-accent-primary hover:underline transition-colors"
        >
          {showAll ? 'Show less' : `Show all ${platforms.length} platforms`}
        </button>
      )}
      {showAll && hasMore && (
        <div className="platform-pill-row">
          {platforms.slice(4).map(platform => (
            <PlatformBadge key={platform.sourceId} platform={platform} onRemoveLink={onRemoveLink} />
          ))}
        </div>
      )}
    </div>
  );
}
