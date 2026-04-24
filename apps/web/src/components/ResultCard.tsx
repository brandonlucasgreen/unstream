import { useState, useEffect, useRef } from 'react';
import type { SearchResult } from '../types';
import { SourceBadge } from './SourceBadge';
import { analytics } from '../services/analytics';
import { ResultCardHeader } from './ResultCardHeader';
import { ResultCardRelease } from './ResultCardRelease';
import { ResultCardPlatforms } from './ResultCardPlatforms';
import { ResultCardSocial } from './ResultCardSocial';
import { ResultCardActions } from './ResultCardActions';
import {
  getSource,
  isDirectLink,
  categorizePlatforms,
  allKnownSourceIds,
  getReleaseInfo,
} from './ResultCardUtils';

interface ResultCardProps {
  result: SearchResult;
  defaultExpanded?: boolean;
  isAdmin?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function ResultCard({ result, defaultExpanded = true, isAdmin, isSelected, onToggleSelect }: ResultCardProps) {
  const searchTracked = useRef(false);

  useEffect(() => {
    if (!searchTracked.current && result.type === 'artist' && result.claimedSlug) {
      analytics.trackArtistSearchAppearance(result.claimedSlug);
      searchTracked.current = true;
    }
  }, [result.type, result.claimedSlug]);

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [shareCopied, setShareCopied] = useState(false);

  const {
    latestRelease,
    platformsWithRelease,
    canPlay,
    previewUrl,
    verifiedPlatforms,
  } = getReleaseInfo(result);

  const categorized = categorizePlatforms(verifiedPlatforms, allKnownSourceIds);

  const searchOnlyPlatforms = result.platforms.filter(p =>
    getSource(p.sourceId)?.searchOnly && !isDirectLink(p.url, p.sourceId)
  );

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = window.location.href;
    const text = `Find ${result.name} on alternative platforms with Unstream`;

    if (navigator.share) {
      try {
        await navigator.share({ title: `${result.name} on Unstream`, text, url });
      } catch { /* cancelled */ }
    } else {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }
  };

  const hasRelease = !!latestRelease && platformsWithRelease.length > 0;
  const hasMarketplaceNoRelease = categorized.marketplace.length > 0 && !hasRelease;

  return (
    <div className="result-card group">
      <ResultCardHeader
        result={result}
        isAdmin={isAdmin}
        isSelected={isSelected}
        onToggleSelect={onToggleSelect}
        expanded={expanded}
        onToggleExpand={() => setExpanded(!expanded)}
        onShare={handleShare}
        shareCopied={shareCopied}
      />

      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border space-y-4 animate-in slide-in-from-top-2 duration-200">
          {/* Unverified match warning */}
          {result.matchConfidence === 'unverified' && (
            <div className="flex items-start gap-2 p-2 rounded bg-yellow-500/5 border border-yellow-500/20 text-yellow-600 text-xs">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>
                <strong>Unverified match:</strong> We couldn't confirm this is the same "{result.name}" as the other results.
                This may be a different artist with the same name.
              </span>
            </div>
          )}

          {/* Wikipedia bio summary */}
          {result.type === 'artist' && result.wikipediaSummary && (
            <div className="space-y-1">
              <p className="text-sm text-text-secondary leading-relaxed">
                {result.wikipediaSummary.length > 200
                  ? result.wikipediaSummary.substring(0, 200).replace(/\s+\S*$/, '') + '...'
                  : result.wikipediaSummary}
                {result.wikipediaUrl && (
                  <>
                    {' '}
                    <a href={result.wikipediaUrl} target="_blank" rel="noopener noreferrer"
                       className="text-accent-primary hover:underline text-xs"
                       onClick={(e) => e.stopPropagation()}>
                      Wikipedia
                    </a>
                  </>
                )}
              </p>
            </div>
          )}

          {/* Featured Release */}
          <ResultCardRelease
            result={result}
            latestRelease={latestRelease}
            platformsWithRelease={platformsWithRelease}
            canPlay={canPlay}
            previewUrl={previewUrl}
          />

          {/* Music Marketplaces */}
          <ResultCardPlatforms
            platforms={categorized.marketplace}
            category="Music Marketplaces"
            showPreview={hasMarketplaceNoRelease && canPlay}
            resultName={result.name}
            canPlay={canPlay}
            previewUrl={previewUrl}
          />

          <ResultCardPlatforms
            platforms={categorized.patronage}
            category="Patronage Platforms"
          />

          <ResultCardPlatforms
            platforms={categorized.decentralized}
            category="Decentralized"
          />

          <ResultCardPlatforms
            platforms={categorized.library}
            category="Library Services"
          />

          <ResultCardPlatforms
            platforms={categorized.official}
            category="Official"
          />

          <ResultCardPlatforms
            platforms={categorized.curated}
            category="Links"
          />

          {/* Social links */}
          <ResultCardSocial
            platforms={categorized.social}
            claimedSlug={result.claimedSlug}
          />

          {/* Search-only platforms */}
          {searchOnlyPlatforms.length > 0 && (
            <div className="pt-2 mt-2 border-t border-border/50 flex items-center flex-wrap">
              <span className="text-sm text-text-secondary py-1">Also try: </span>
              {searchOnlyPlatforms.map(platform => (
                <SourceBadge
                  key={platform.sourceId}
                  source={getSource(platform.sourceId)}
                  url={platform.url}
                  displayName={platform.displayName}
                />
              ))}
            </div>
          )}

          {/* Actions: app promo, claim, report, legend */}
          <ResultCardActions result={result} />
        </div>
      )}
    </div>
  );
}
