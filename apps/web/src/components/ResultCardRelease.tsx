import type { SearchResult } from '../types';
import { getSource } from './ResultCardUtils';
import { ResultCardPreview } from './ResultCardPreview';
import { analytics } from '../services/analytics';
import { badgeColors } from '../utils/colors';
import { usePrefersLightTheme } from '../hooks/usePrefersLightTheme';

interface ResultCardReleaseProps {
  result: SearchResult;
  latestRelease: NonNullable<SearchResult['platforms'][number]['latestRelease']> | undefined;
  platformsWithRelease: SearchResult['platforms'];
  canPlay: boolean;
  previewUrl: string | undefined;
}

export function ResultCardRelease({ result, latestRelease, platformsWithRelease, canPlay, previewUrl }: ResultCardReleaseProps) {
  // Chip text is fitted for contrast against a theme-specific composited
  // background, so the component needs to know which theme is active.
  const lightTheme = usePrefersLightTheme();
  if (!latestRelease || platformsWithRelease.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-accent-secondary uppercase tracking-wider">
        Featured Release
      </h4>
      <p className="text-sm font-medium text-text-primary">
        {latestRelease.title}
      </p>
      <div className="flex items-start gap-3">
        {latestRelease.imageUrl && (
          <img
            src={latestRelease.imageUrl}
            alt={latestRelease.title}
            className="w-16 h-16 rounded object-cover flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0 space-y-2">
          <ResultCardPreview
            resultName={result.name}
            canPlay={canPlay}
            previewUrl={previewUrl}
          />
          {/* Platform links for release */}
          <div className="flex flex-wrap gap-1.5">
            {platformsWithRelease.map(platform => {
              const { textColor, bgColor } = badgeColors(getSource(platform.sourceId).color, lightTheme ? 'light' : 'dark');
              return (
                <a
                  key={`release-${platform.sourceId}`}
                  href={platform.latestRelease?.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors hover:opacity-80"
                  style={{
                    backgroundColor: bgColor,
                    color: textColor,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    // One tracker per click: trackArtistLinkClick already records the platform_click
                    // product event, so also calling trackPlatformClick double-counted claimed clicks.
                    if (result.claimedSlug) analytics.trackArtistLinkClick(result.claimedSlug, platform.sourceId);
                    else analytics.trackPlatformClick(platform.displayName ?? getSource(platform.sourceId).name);
                  }}
                >
                  <span>{getSource(platform.sourceId).icon}</span>
                  <span>{platform.displayName ?? getSource(platform.sourceId).name}</span>
                </a>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
