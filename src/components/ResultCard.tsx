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

  // Separate verified matches from search-only links
  const verifiedPlatforms = result.platforms.filter(p => !sources[p.sourceId]?.searchOnly);

  // Collect platforms that have latest release info
  const platformsWithRelease = verifiedPlatforms.filter(p => p.latestRelease);
  const latestRelease = platformsWithRelease[0]?.latestRelease;

  // Get the Bandcamp release URL for preview (prefer latest release URL over artist page)
  const bandcampWithRelease = platformsWithRelease.find(p => p.sourceId === 'bandcamp');
  const previewUrl = bandcampWithRelease?.latestRelease?.url || bandcampPlatform?.url;

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

    if (!previewUrl) return;

    setEmbedLoading(true);
    setEmbedError(false);

    try {
      const response = await fetch(`/api/embed/bandcamp?url=${encodeURIComponent(previewUrl)}`);
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

  const searchOnlyPlatforms = result.platforms.filter(p => sources[p.sourceId]?.searchOnly);

  // Group verified platforms by category
  const categorizedPlatforms = {
    marketplace: verifiedPlatforms.filter(p =>
      sourceCategories.marketplace.sources.includes(p.sourceId)
    ),
    patronage: verifiedPlatforms.filter(p =>
      sourceCategories.patronage.sources.includes(p.sourceId)
    ),
    library: verifiedPlatforms.filter(p =>
      sourceCategories.library.sources.includes(p.sourceId)
    ),
    decentralized: verifiedPlatforms.filter(p =>
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
        <div className="w-16 h-16 flex-shrink-0 rounded overflow-hidden bg-bg-secondary">
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
            <span className="text-xs px-1.5 py-0.5 rounded bg-accent-primary/10 text-accent-primary">
              {typeLabel}
            </span>
          </div>
          <h3 className="font-medium text-base text-text-primary truncate">
            {result.name}
          </h3>
          {result.artist && (
            <p className="text-text-secondary text-sm truncate">
              by {result.artist}
            </p>
          )}
        </div>

        {/* Platform count and expand arrow */}
        <div className="flex-shrink-0 flex items-center gap-3 text-text-muted">
          <span className="text-sm text-accent-secondary">
            {verifiedPlatforms.length} platform{verifiedPlatforms.length !== 1 ? 's' : ''}
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
          {/* Latest Release Section with Preview */}
          {latestRelease && platformsWithRelease.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-accent-secondary uppercase tracking-wider">
                Latest Release
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
                  {/* Preview button/player */}
                  {canPlay && (
                    <div>
                      {showPlayer && embedData ? (
                        <div className="flex items-center gap-2">
                          <iframe
                            src={embedData.embedUrl}
                            seamless
                            className="flex-1 border-0 rounded"
                            style={{ height: '42px' }}
                            title={`${result.name} - ${embedData.title}`}
                          />
                          <button
                            onClick={(e) => { e.stopPropagation(); setShowPlayer(false); }}
                            className="flex-shrink-0 p-1.5 rounded text-text-muted hover:text-text-primary transition-colors"
                            title="Close preview"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ) : embedError ? (
                        <p className="text-xs text-red-400">Could not load preview</p>
                      ) : (
                        <button
                          onClick={handlePlayClick}
                          disabled={embedLoading}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-sm bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors ${embedLoading ? 'opacity-50 cursor-wait' : ''}`}
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
                    </div>
                  )}
                  {/* Platform links for release */}
                  <div className="flex flex-wrap gap-1.5">
                    {platformsWithRelease.map(platform => (
                      <a
                        key={`release-${platform.sourceId}`}
                        href={platform.latestRelease?.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors hover:opacity-80"
                        style={{
                          backgroundColor: `${sources[platform.sourceId].color}20`,
                          color: sources[platform.sourceId].color,
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span>{sources[platform.sourceId].icon}</span>
                        <span>{sources[platform.sourceId].name}</span>
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Artist Profiles - more compact when we have releases */}
          {categorizedPlatforms.marketplace.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                {latestRelease ? 'Artist Profiles' : 'Music Marketplaces'}
              </h4>
              {/* Preview button when no latest release but Bandcamp exists */}
              {!latestRelease && canPlay && (
                <div className="mb-2">
                  {showPlayer && embedData ? (
                    <div className="flex items-center gap-2">
                      <iframe
                        src={embedData.embedUrl}
                        seamless
                        className="flex-1 border-0 rounded"
                        style={{ height: '42px' }}
                        title={`${result.name} - ${embedData.title}`}
                      />
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowPlayer(false); }}
                        className="flex-shrink-0 p-1.5 rounded text-text-muted hover:text-text-primary transition-colors"
                        title="Close preview"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ) : embedError ? (
                    <p className="text-xs text-red-400">Could not load preview</p>
                  ) : (
                    <button
                      onClick={handlePlayClick}
                      disabled={embedLoading}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-sm bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors ${embedLoading ? 'opacity-50 cursor-wait' : ''}`}
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
                </div>
              )}
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

          {/* Search-only platforms - subtle section */}
          {searchOnlyPlatforms.length > 0 && (
            <div className="pt-2 mt-2 border-t border-border/50 flex items-center flex-wrap">
              <span className="text-sm text-text-secondary py-1">Also try: </span>
              {searchOnlyPlatforms.map(platform => (
                <SourceBadge
                  key={platform.sourceId}
                  source={sources[platform.sourceId]}
                  url={platform.url}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
