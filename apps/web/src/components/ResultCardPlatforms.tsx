import { SourceBadge } from './SourceBadge';
import { ResultCardPreview } from './ResultCardPreview';
import { getSource, isDirectLink } from './ResultCardUtils';
import type { PlatformLink } from '../types';

interface ResultCardPlatformsProps {
  platforms: PlatformLink[];
  category: string;
  showPreview?: boolean;
  resultName?: string;
  canPlay?: boolean;
  previewUrl?: string | undefined;
}

export function ResultCardPlatforms({ platforms, category, showPreview, resultName, canPlay, previewUrl }: ResultCardPlatformsProps) {
  if (platforms.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
        {category}
      </h4>
        {showPreview && resultName != null && canPlay != null && previewUrl !== undefined && (
          <div className="mb-2">
            <ResultCardPreview
              resultName={resultName}
              canPlay={canPlay}
              previewUrl={previewUrl}
            />
          </div>
        )}
      <div className="flex flex-wrap gap-2">
        {platforms.map(platform => (
          <SourceBadge
            key={platform.sourceId}
            source={getSource(platform.sourceId)}
            url={platform.url}
            isDirectLink={isDirectLink(platform.url, platform.sourceId)}
            displayName={platform.displayName}
          />
        ))}
      </div>
    </div>
  );
}
