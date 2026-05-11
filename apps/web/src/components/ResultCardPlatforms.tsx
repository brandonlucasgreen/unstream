import { SourceBadge } from './SourceBadge';
import { getSource, isDirectLink } from './ResultCardUtils';
import type { PlatformLink } from '../types';
import { useState } from 'react';

interface ResultCardPlatformsProps {
  platforms: PlatformLink[];
  category: string;
  compact?: boolean;
}

export function ResultCardPlatforms({ platforms, category, compact = false }: ResultCardPlatformsProps) {
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
      <div className="flex flex-wrap gap-2">
        {visiblePlatforms.map(platform => (
          <SourceBadge
            key={platform.sourceId}
            source={getSource(platform.sourceId)}
            url={platform.url}
            isDirectLink={isDirectLink(platform.url, platform.sourceId)}
            displayName={platform.displayName}
          />
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
        <div className="flex flex-wrap gap-2">
          {platforms.slice(4).map(platform => (
            <SourceBadge
              key={platform.sourceId}
              source={getSource(platform.sourceId)}
              url={platform.url}
              isDirectLink={isDirectLink(platform.url, platform.sourceId)}
              displayName={platform.displayName}
            />
          ))}
        </div>
      )}
    </div>
  );
}
