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
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportText, setReportText] = useState('');

  // Separate verified matches from search-only links
  const verifiedPlatforms = result.platforms.filter(p => !sources[p.sourceId]?.searchOnly);

  // Collect platforms that have latest release info
  const platformsWithRelease = verifiedPlatforms.filter(p => p.latestRelease);
  const latestRelease = platformsWithRelease[0]?.latestRelease;

  // Only show preview if Bandcamp has the latest release
  // (Qobuz widget is unreliable, so we don't offer preview for Qobuz-only releases)
  const bandcampWithRelease = platformsWithRelease.find(p => p.sourceId === 'bandcamp');

  const canPlay = !!bandcampWithRelease?.latestRelease;
  const previewUrl = bandcampWithRelease?.latestRelease?.url;

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

  const handleReportSubmit = (e: React.MouseEvent) => {
    e.stopPropagation();
    const platformList = result.platforms.map(p => `- ${sources[p.sourceId]?.name}: ${p.url}`).join('\n');
    const subject = encodeURIComponent(`Issue Report: ${result.name}`);
    const body = encodeURIComponent(
      `Artist/Result: ${result.name}\n` +
      `Type: ${result.type}\n` +
      `Match Confidence: ${result.matchConfidence || 'N/A'}\n\n` +
      `Platforms:\n${platformList}\n\n` +
      `Issue Description:\n${reportText}\n`
    );
    window.location.href = `mailto:support@unstream.stream?subject=${subject}&body=${body}`;
    setShowReportForm(false);
    setReportText('');
  };

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
            {result.matchConfidence === 'unverified' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-500 flex items-center gap-1" title="Could not verify this is the same artist - no matching releases found">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Unverified
              </span>
            )}
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

          {/* Report issue section */}
          <div className="pt-3 mt-3 border-t border-border/50">
            {!showReportForm ? (
              <button
                onClick={(e) => { e.stopPropagation(); setShowReportForm(true); }}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Report an issue with this result
              </button>
            ) : (
              <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                <label className="text-xs text-text-secondary block">
                  What's wrong with this result?
                </label>
                <textarea
                  value={reportText}
                  onChange={(e) => setReportText(e.target.value)}
                  placeholder="e.g., Wrong artist, mismatched platforms, broken link..."
                  className="w-full px-3 py-2 text-sm bg-bg-secondary border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/50 resize-none"
                  rows={3}
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleReportSubmit}
                    disabled={!reportText.trim()}
                    className="px-3 py-1.5 text-xs font-medium bg-accent-primary/10 text-accent-primary rounded-lg hover:bg-accent-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Send Report
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowReportForm(false); setReportText(''); }}
                    className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
