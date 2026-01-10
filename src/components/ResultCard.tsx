import { useState } from 'react';
import type { SearchResult, SourceId } from '../types';
import { sources, sourceCategories } from '../services/sources';
import { SourceBadge } from './SourceBadge';
import { analytics } from '../services/analytics';

// Social media platform icons (simplified SVG paths)
function SocialIcon({ platform }: { platform: SourceId }) {
  const iconClass = "w-4 h-4";
  const color = sources[platform]?.color || '#666';

  switch (platform) {
    case 'instagram':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill={color}>
          <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
        </svg>
      );
    case 'facebook':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill={color}>
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
        </svg>
      );
    case 'tiktok':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill={color}>
          <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>
        </svg>
      );
    case 'youtube':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill={color}>
          <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
        </svg>
      );
    case 'threads':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill={color}>
          <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.96-.065-1.182.408-2.256 1.33-3.022.88-.73 2.082-1.168 3.59-1.304 1.245-.113 2.386-.016 3.414.293.01-.653-.07-1.222-.25-1.69-.21-.549-.579-.972-1.097-1.259-.567-.313-1.304-.475-2.19-.48-1.236.017-2.274.377-2.987 1.064a3.1 3.1 0 0 0-.703 1.088l-1.943-.64c.263-.69.648-1.29 1.153-1.795 1.093-1.09 2.614-1.673 4.397-1.692h.103c1.593.014 2.937.41 3.893 1.152.918.712 1.52 1.702 1.79 2.945.252 1.157.19 2.523-.124 4.06a7.28 7.28 0 0 1-.039.194c.9.56 1.604 1.283 2.07 2.153.632 1.183.903 2.772.209 4.449-1.855 4.482-7.86 4.687-10.042 4.675l-.032.001zm.256-8.816c-.084 0-.168.002-.253.006-1.597.087-2.61.806-2.563 1.822.023.462.241.886.649 1.149.474.307 1.165.463 1.94.42 1.104-.06 1.946-.47 2.502-1.22.382-.514.654-1.178.797-1.977-.98-.165-2.006-.222-3.072-.2z"/>
        </svg>
      );
    case 'bluesky':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill={color}>
          <path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z"/>
        </svg>
      );
    case 'twitter':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill={color}>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
      );
    case 'mastodon':
      return (
        <svg className={iconClass} viewBox="0 0 24 24" fill="#858AFA">
          <path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z"/>
        </svg>
      );
    default:
      return null;
  }
}

interface ResultCardProps {
  result: SearchResult;
  defaultExpanded?: boolean;
}

interface EmbedData {
  embedUrl: string;
  title: string;
}

export function ResultCard({ result, defaultExpanded = false }: ResultCardProps) {
  const [imageError, setImageError] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [embedData, setEmbedData] = useState<EmbedData | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [embedError, setEmbedError] = useState(false);
  const [showPlayer, setShowPlayer] = useState(false);
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportText, setReportText] = useState('');

  // Helper to check if a URL is a direct link vs a search URL
  const isDirectLink = (url: string, sourceId: SourceId): boolean => {
    // If the source isn't searchOnly, it's always direct
    if (!sources[sourceId]?.searchOnly) return true;
    // Check if URL looks like a search URL (contains search patterns)
    const searchPatterns = ['/search', '?q=', '?query=', '/explore', 'duckduckgo.com'];
    return !searchPatterns.some(pattern => url.toLowerCase().includes(pattern));
  };

  // Separate verified matches from search-only links
  // A platform is verified if it's not searchOnly OR if we have a direct link to it
  const verifiedPlatforms = result.platforms.filter(p =>
    !sources[p.sourceId]?.searchOnly || isDirectLink(p.url, p.sourceId)
  );

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

  const searchOnlyPlatforms = result.platforms.filter(p =>
    sources[p.sourceId]?.searchOnly && !isDirectLink(p.url, p.sourceId)
  );

  const handleReportSubmit = (e: React.MouseEvent) => {
    e.stopPropagation();
    analytics.trackReportIssue();
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
    official: verifiedPlatforms.filter(p =>
      sourceCategories.official.sources.includes(p.sourceId)
    ),
    social: verifiedPlatforms.filter(p =>
      sourceCategories.social.sources.includes(p.sourceId)
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
          {/* Featured Release Section with Preview */}
          {latestRelease && platformsWithRelease.length > 0 && (
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
                        onClick={(e) => { e.stopPropagation(); analytics.trackPlatformClick(sources[platform.sourceId].name); }}
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

          {/* Music Marketplaces */}
          {categorizedPlatforms.marketplace.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                Music Marketplaces
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
                    isDirectLink={isDirectLink(platform.url, platform.sourceId)}
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
                    isDirectLink={isDirectLink(platform.url, platform.sourceId)}
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
                    isDirectLink={isDirectLink(platform.url, platform.sourceId)}
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
                    isDirectLink={isDirectLink(platform.url, platform.sourceId)}
                  />
                ))}
              </div>
            </div>
          )}

          {categorizedPlatforms.official.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                Official
              </h4>
              <div className="flex flex-wrap gap-2">
                {categorizedPlatforms.official.map(platform => (
                  <SourceBadge
                    key={platform.sourceId}
                    source={sources[platform.sourceId]}
                    url={platform.url}
                    isDirectLink={isDirectLink(platform.url, platform.sourceId)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Social links - small logo row */}
          {categorizedPlatforms.social.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
                Social
              </h4>
              <div className="flex flex-wrap gap-3">
                {categorizedPlatforms.social.map(platform => (
                  <a
                    key={platform.sourceId}
                    href={platform.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-8 h-8 flex items-center justify-center rounded-full bg-bg-secondary hover:bg-bg-tertiary transition-colors"
                    title={sources[platform.sourceId].name}
                    onClick={(e) => { e.stopPropagation(); analytics.trackPlatformClick(sources[platform.sourceId].name); }}
                  >
                    <SocialIcon platform={platform.sourceId} />
                  </a>
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
