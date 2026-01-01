import { useState } from 'react';
import type { SearchResult } from '../types';
import { sources, sourceCategories } from '../services/sources';
import { SourceBadge } from './SourceBadge';

interface ResultCardProps {
  result: SearchResult;
}

interface EmbedData {
  embedUrl: string;
  title: string;
}

export function ResultCard({ result }: ResultCardProps) {
  const [imageError, setImageError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [embedData, setEmbedData] = useState<EmbedData | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [embedError, setEmbedError] = useState(false);
  const [showPlayer, setShowPlayer] = useState(false);

  // Check if this result has a Bandcamp link
  const bandcampPlatform = result.platforms.find(p => p.sourceId === 'bandcamp');
  const canPlay = !!bandcampPlatform;

  const handlePlayClick = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger expand

    if (showPlayer && embedData) {
      // Toggle off if already showing
      setShowPlayer(false);
      return;
    }

    if (embedData) {
      // Already loaded, just show
      setShowPlayer(true);
      return;
    }

    if (!bandcampPlatform) return;

    setEmbedLoading(true);
    setEmbedError(false);

    try {
      const response = await fetch(`/api/embed/bandcamp?url=${encodeURIComponent(bandcampPlatform.url)}`);
      if (!response.ok) throw new Error('Failed to fetch embed');
      const data = await response.json();
      setEmbedData(data);
      setShowPlayer(true);
    } catch (err) {
      console.error('Embed error:', err);
      setEmbedError(true);
    } finally {
      setEmbedLoading(false);
    }
  };

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

        {/* Preview button and Platform count */}
        <div className="flex-shrink-0 flex items-center gap-3 text-text-muted">
          {canPlay && !showPlayer && (
            <button
              onClick={handlePlayClick}
              disabled={embedLoading}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 ${embedLoading ? 'opacity-50 cursor-wait' : ''}`}
            >
              {embedLoading ? (
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
              <span>Preview</span>
            </button>
          )}
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

      {/* Embedded Player */}
      {showPlayer && embedData && (
        <div className="px-4 pb-4 border-t border-border">
          <div className="pt-3 flex items-center gap-2">
            <iframe
              src={embedData.embedUrl}
              seamless
              className="flex-1 border-0 rounded-lg"
              style={{ height: '42px' }}
              title={`${result.name} - ${embedData.title}`}
            />
            <button
              onClick={(e) => { e.stopPropagation(); setShowPlayer(false); }}
              className="flex-shrink-0 p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
              title="Close preview"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Embed Error */}
      {embedError && (
        <div className="px-4 pb-4 border-t border-border">
          <div className="pt-3 flex items-center justify-between">
            <p className="text-sm text-red-400">
              Could not load preview. Try visiting the Bandcamp page directly.
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); setEmbedError(false); }}
              className="flex-shrink-0 p-1 rounded text-text-muted hover:text-text-primary"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

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
