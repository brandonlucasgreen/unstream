import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { SearchResult, SourceId } from '../types';
import { sources, sourceCategories } from '../services/sources';
import { SourceBadge } from './SourceBadge';
import { SocialIcon } from './SocialIcon';
import { analytics } from '../services/analytics';

interface ResultCardProps {
  result: SearchResult;
  defaultExpanded?: boolean;
  isAdmin?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (id: string) => void;
}

interface EmbedData {
  embedUrl: string;
  title: string;
}

export function ResultCard({ result, defaultExpanded = true, isAdmin, isSelected, onToggleSelect }: ResultCardProps) {
  const searchTracked = useRef(false);

  // Track search appearance for claimed artists (once per mount)
  useEffect(() => {
    if (!searchTracked.current && result.type === 'artist' && result.claimedSlug) {
      analytics.trackArtistSearchAppearance(result.claimedSlug);
      searchTracked.current = true;
    }
  }, [result.type, result.claimedSlug]);

  const [imageError, setImageError] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [embedData, setEmbedData] = useState<EmbedData | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);
  const [embedError, setEmbedError] = useState(false);
  const [showPlayer, setShowPlayer] = useState(false);
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportText, setReportText] = useState('');
  const [shareCopied, setShareCopied] = useState(false);

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
  // Prioritize Bandcamp over other platforms for featured release display
  const allPlatformsWithRelease = verifiedPlatforms
    .filter(p => p.latestRelease)
    .sort((a, b) => {
      // Bandcamp always comes first
      if (a.sourceId === 'bandcamp' && b.sourceId !== 'bandcamp') return -1;
      if (a.sourceId !== 'bandcamp' && b.sourceId === 'bandcamp') return 1;
      return 0;
    });
  const latestRelease = allPlatformsWithRelease[0]?.latestRelease;

  // Only show platforms that have the SAME release as the featured one
  // This prevents showing Qobuz link for a different release than what's featured
  const normalizeTitle = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const featuredTitle = latestRelease ? normalizeTitle(latestRelease.title) : '';
  const platformsWithRelease = allPlatformsWithRelease.filter(p => {
    if (!p.latestRelease || !featuredTitle) return false;
    const platformTitle = normalizeTitle(p.latestRelease.title);
    // Match if titles are the same or one contains the other
    return platformTitle === featuredTitle ||
      platformTitle.includes(featuredTitle) ||
      featuredTitle.includes(platformTitle);
  });

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
    artist: '\uD83D\uDC64',
    album: '\uD83D\uDCBF',
    track: '\uD83C\uDFB5',
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
        {/* Admin merge checkbox */}
        {isAdmin && result.type === 'artist' && result.matchConfidence !== 'claimed' && onToggleSelect && (
          <div className="flex items-center flex-shrink-0">
            <input
              type="checkbox"
              checked={!!isSelected}
              onChange={() => onToggleSelect(result.id)}
              onClick={(e) => e.stopPropagation()}
              className="w-5 h-5 rounded border-border text-accent-primary focus:ring-accent-primary/50 cursor-pointer"
            />
          </div>
        )}
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
            {result.matchConfidence !== 'claimed' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-accent-primary/10 text-accent-primary">
                {typeLabel}
              </span>
            )}
            {result.matchConfidence === 'claimed' && (
              <>
                <span
                  className="text-xs px-1.5 py-0.5 rounded bg-accent-primary/15 text-accent-primary flex items-center gap-1"
                  title="This artist has verified their Unstream profile"
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Verified
                </span>
                <a
                  href={`/a/${result.claimedSlug || result.id}`}
                  className="text-xs px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  View profile
                </a>
              </>
            )}
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

        {/* Action buttons + expand arrow */}
        <div className="flex-shrink-0 flex items-center gap-1">
          {/* Share button */}
          <button
            onClick={handleShare}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
            title="Share this result"
          >
            {shareCopied ? (
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            )}
          </button>
          {/* Expand/collapse arrow */}
          <svg
            className={`w-5 h-5 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
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
                        onClick={(e) => {
                          e.stopPropagation();
                          analytics.trackPlatformClick(sources[platform.sourceId].name);
                          if (result.claimedSlug) analytics.trackArtistLinkClick(result.claimedSlug, platform.sourceId);
                        }}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      analytics.trackPlatformClick(sources[platform.sourceId].name);
                      if (result.claimedSlug) analytics.trackArtistLinkClick(result.claimedSlug, platform.sourceId);
                    }}
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

          {/* Save / app promo - always visible */}
          {result.type === 'artist' && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-accent-primary/5 border border-accent-primary/10">
              <svg className="w-4 h-4 text-accent-primary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text-secondary">
                  <span className="font-medium text-text-primary">Save artists &amp; get release alerts</span>
                  {' '}with the free{' '}
                  <a
                    href="https://github.com/brandonlucasgreen/unstream/releases/latest"
                    className="text-accent-primary hover:underline"
                    onClick={(e) => { e.stopPropagation(); analytics.trackDownload(); }}
                  >
                    Mac app
                  </a>
                  {' '}or browser extension for{' '}
                  <a
                    href="https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-primary hover:underline"
                    onClick={(e) => { e.stopPropagation(); analytics.trackDownload(); }}
                  >
                    Chrome
                  </a>
                  {' / '}
                  <a
                    href="https://addons.mozilla.org/en-US/firefox/addon/unstream/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-primary hover:underline"
                    onClick={(e) => { e.stopPropagation(); analytics.trackDownload(); }}
                  >
                    Firefox
                  </a>
                </p>
              </div>
            </div>
          )}

          {/* Claim + Report on same line */}
          <div className="pt-3 mt-3 border-t border-border/50">
            {showReportForm ? (
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
            ) : (
              <div className="flex items-center justify-between">
                {/* Claim - left */}
                {result.type === 'artist' && result.matchConfidence !== 'claimed' ? (
                  <Link
                    to={`/claim/${result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}
                    className="text-xs text-text-muted hover:text-accent-primary transition-colors flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    Are you {result.name}? Claim your artist page
                  </Link>
                ) : (
                  <div />
                )}
                {/* Report - right */}
                <button
                  onClick={(e) => { e.stopPropagation(); setShowReportForm(true); }}
                  className="text-xs text-text-muted hover:text-text-secondary transition-colors flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  Report this result
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
