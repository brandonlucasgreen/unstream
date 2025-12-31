import { useState } from 'react';
import type { SearchResult } from '../types';
import { sources, sourceCategories } from '../services/sources';
import { SourceBadge } from './SourceBadge';

interface ResultCardProps {
  result: SearchResult;
}

export function ResultCard({ result }: ResultCardProps) {
  const [imageError, setImageError] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Group platforms by category
  const categorizedPlatforms = {
    marketplace: result.platforms.filter(p =>
      sourceCategories.marketplace.sources.includes(p.sourceId)
    ),
    patronage: result.platforms.filter(p =>
      sourceCategories.patronage.sources.includes(p.sourceId)
    ),
    library: result.platforms.filter(p =>
      sourceCategories.library.sources.includes(p.sourceId)
    ),
    decentralized: result.platforms.filter(p =>
      sourceCategories.decentralized.sources.includes(p.sourceId)
    ),
  };

  const typeIcon = {
    artist: '👤',
    album: '💿',
    track: '🎵',
  }[result.type];

  const typeLabel = {
    artist: 'Artist',
    album: 'Album',
    track: 'Track',
  }[result.type];

  return (
    <div className="result-card group">
      <div
        className="flex gap-4 p-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Thumbnail */}
        <div className="w-20 h-20 flex-shrink-0 rounded-lg overflow-hidden bg-bg-secondary">
          {result.imageUrl && !imageError ? (
            <img
              src={result.imageUrl}
              alt={result.name}
              className="w-full h-full object-cover"
              onError={() => setImageError(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-3xl text-text-muted">
              {typeIcon}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs px-2 py-0.5 rounded-full bg-accent-primary/10 text-accent-primary font-medium">
              {typeLabel}
            </span>
          </div>
          <h3 className="font-semibold text-lg text-text-primary truncate group-hover:text-accent-primary transition-colors">
            {result.name}
          </h3>
          {result.artist && (
            <p className="text-text-secondary text-sm truncate">
              by {result.artist}
            </p>
          )}
        </div>

        {/* Platform count */}
        <div className="flex-shrink-0 flex items-center gap-2 text-text-muted">
          <span className="text-sm text-accent-secondary">
            {result.platforms.length} platform{result.platforms.length !== 1 ? 's' : ''}
          </span>
          <svg
            className={`w-5 h-5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Expanded platform list */}
      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border space-y-4 animate-in slide-in-from-top-2 duration-200">
          {categorizedPlatforms.marketplace.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                Music Marketplaces
              </h4>
              <div className="flex flex-wrap gap-2">
                {categorizedPlatforms.marketplace.map(platform => (
                  <SourceBadge
                    key={platform.sourceId}
                    source={sources[platform.sourceId]}
                    url={platform.url}
                  />
                ))}
              </div>
            </div>
          )}

          {categorizedPlatforms.patronage.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                Patronage Platforms
              </h4>
              <div className="flex flex-wrap gap-2">
                {categorizedPlatforms.patronage.map(platform => (
                  <SourceBadge
                    key={platform.sourceId}
                    source={sources[platform.sourceId]}
                    url={platform.url}
                  />
                ))}
              </div>
            </div>
          )}

          {categorizedPlatforms.decentralized.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                Decentralized
              </h4>
              <div className="flex flex-wrap gap-2">
                {categorizedPlatforms.decentralized.map(platform => (
                  <SourceBadge
                    key={platform.sourceId}
                    source={sources[platform.sourceId]}
                    url={platform.url}
                  />
                ))}
              </div>
            </div>
          )}

          {categorizedPlatforms.library.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                Library Services
              </h4>
              <div className="flex flex-wrap gap-2">
                {categorizedPlatforms.library.map(platform => (
                  <SourceBadge
                    key={platform.sourceId}
                    source={sources[platform.sourceId]}
                    url={platform.url}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
