import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { SearchBar } from '../components/SearchBar';
import { ResultCard } from '../components/ResultCard';
import { LoginInterstitial } from '../components/LoginInterstitial';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import type { SearchResult } from '../types';
import { searchPlatforms, fetchMusicBrainzData, mergeWithMusicBrainzData } from '../services/sources';
import { analytics } from '../services/analytics';
import { useAuth } from '../contexts/AuthContext';

export function ArtistPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const justClaimed = searchParams.get('claimed') !== null;
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEnriching, setIsEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artistName, setArtistName] = useState('');
  const [claimBannerDismissed, setClaimBannerDismissed] = useState(false);
  const [claimShareCopied, setClaimShareCopied] = useState(false);
  const { session, isArtistSaved, saveArtist, removeSavedArtist } = useAuth();

  // Get the first artist result for save button
  const primaryArtist = results.find(r => r.type === 'artist');
  const isSaved = primaryArtist ? isArtistSaved(primaryArtist.id) : false;

  const [showLoginInterstitial, setShowLoginInterstitial] = useState(false);

  const handleSaveArtist = async () => {
    if (!primaryArtist || !primaryArtist.id) return;

    if (isSaved) {
      await removeSavedArtist(primaryArtist.id);
    } else {
      if (!session) {
        setShowLoginInterstitial(true);
        return;
      }
      await saveArtist(primaryArtist.id, undefined, primaryArtist.name, primaryArtist.imageUrl);
    }
  };

  const handleClaimShare = async () => {
    const url = `https://unstream.stream/a/${slug}`;
    const text = `Find my music on alternative platforms with Unstream`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${displayName} on Unstream`, text, url });
      } catch { /* cancelled */ }
    } else {
      await navigator.clipboard.writeText(url);
      setClaimShareCopied(true);
      setTimeout(() => setClaimShareCopied(false), 2000);
    }
  };

  // Derive display name from slug as initial value
  const displayName = artistName || (slug?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '');

  // Is this a claimed artist profile? (single claimed result = dedicated profile page)
  const isClaimedArtist = results.length === 1 && results[0].type === 'artist' && results[0].matchConfidence === 'claimed';

  // Update page title and meta tags
  useEffect(() => {
    if (displayName) {
      document.title = `${displayName} on Bandcamp & alternative platforms | Unstream`;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        metaDesc.setAttribute('content', `${displayName} is on Bandcamp and other alternative platforms. Find direct links and support them outside streaming.`);
      }
    }
    return () => {
      document.title = 'Unstream - Support artists directly';
    };
  }, [displayName]);

  // Track page view (once per slug)
  useEffect(() => {
    if (slug) analytics.trackArtistPageView(slug);
  }, [slug]);

  // Load artist data
  useEffect(() => {
    if (!slug) return;

    const artistSlug = slug;
    let cancelled = false;

    async function loadArtist() {
      setIsLoading(true);
      setError(null);

      // Try pre-generated data first
      try {
        const res = await fetch(`/data/artists/${artistSlug}.json`);
        if (res.ok && res.headers.get('content-type')?.includes('json')) {
          const data: SearchResult[] = await res.json();
          if (!cancelled && data.length > 0) {
            setResults(data);
            const firstArtist = data.find(r => r.type === 'artist');
            if (firstArtist) setArtistName(firstArtist.name);
            setIsLoading(false);
            return;
          }
        }
      } catch {
        // Fall through to live fetch
      }

      // Fallback: fetch from API for claimed artists (no pre-generated JSON)
      // This ensures artists can view their claimed profiles even without pre-built JSON
      try {
        const response = await fetch(`/api/artist?slug=${encodeURIComponent(artistSlug)}`);
        if (response.ok && !cancelled) {
          const data: SearchResult = await response.json();
          // Convert single artist result to array format
          const resultsArray: SearchResult[] = data ? [data] : [];
          setResults(resultsArray);
          if (resultsArray.length > 0) {
            const firstArtist = resultsArray.find(r => r.type === 'artist');
            if (firstArtist) setArtistName(firstArtist.name);
          }
          setIsLoading(false);
          return;
        }
      } catch {
        // Fall through to search
      }

      // Last resort: live search using the slug as query
      const query = artistSlug.replace(/-/g, ' ');
      try {
        const response = await searchPlatforms(query);
        if (cancelled) return;

        setResults(response.results);
        if (response.results.length > 0) {
          const firstArtist = response.results.find(r => r.type === 'artist');
          if (firstArtist) setArtistName(firstArtist.name);
        }
        setIsLoading(false);

        // MusicBrainz enrichment
        if (response.hasPendingEnrichment && response.results.length > 0) {
          setIsEnriching(true);
          try {
            const mbData = await fetchMusicBrainzData(query);
            if (!cancelled && mbData) {
              setResults(prev => mergeWithMusicBrainzData(prev, mbData));
            }
          } catch {
            // Silent failure for enrichment
          } finally {
            if (!cancelled) setIsEnriching(false);
          }
        }
      } catch {
        if (!cancelled) {
          setError('Failed to load artist data. Please try again.');
          setIsLoading(false);
        }
      }
    }

    loadArtist();
    return () => { cancelled = true; };
  }, [slug]);

  const handleSearch = useCallback((query: string) => {
    analytics.trackSearch();
    navigate(`/?q=${encodeURIComponent(query)}`);
  }, [navigate]);

  const macAppPromo = (
    <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
      <div className="flex flex-col md:flex-row items-center gap-6 md:gap-10">
        <div className="flex-1 text-center md:text-left">
          <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-3">
            Support the artist you're listening to right now
          </h2>
          <p className="text-text-secondary mb-4">
            Unstream for macOS detects what's playing in Spotify or Apple Music and shows the best ways to support that artist, right in your menu bar.
          </p>
          <p className="text-text-secondary mb-4">
            The browser extension does the same for any music playing in your browser (YouTube, Soundcloud, and more).
          </p>
          <p className="text-text-secondary mb-6">
            Unstream is free because the point is getting money to artists, not charging you to find them. If you find it useful, consider <a href="/support" className="text-accent-primary hover:underline"><strong>supporting its development</strong></a> 🤘
          </p>
          <div className="flex flex-col items-center gap-3 mb-2">
            <a
              href="https://github.com/brandonlucasgreen/unstream/releases/latest"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-accent-primary text-white hover:bg-accent-primary/90 transition-colors font-medium shadow-lg shadow-accent-primary/20"
              onClick={() => analytics.trackDownload()}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              Download for macOS
            </a>
            <div className="flex flex-row items-center gap-3">
              <a
                href="https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-surface border border-border text-text-primary hover:bg-surface-secondary transition-colors font-medium"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728z"/>
                </svg>
                Install for Chrome
              </a>
              <a
                href="https://addons.mozilla.org/en-US/firefox/addon/unstream/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-surface border border-border text-text-primary hover:bg-surface-secondary transition-colors font-medium"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z"/>
                </svg>
                Install for Firefox
              </a>
            </div>
          </div>
          <p className="text-text-muted text-sm mt-2 text-center">Safari extension coming soon!</p>
        </div>
        <div className="flex-shrink-0">
          <img
            src="/unstream-mac-teaser.png"
            alt="Unstream for macOS showing artist platforms in the menu bar"
            className="w-64 md:w-80 rounded-xl shadow-2xl border border-border"
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">

      <Header />

      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          {/* Search bar — only show for unclaimed/search results, not dedicated profiles */}
          {!isClaimedArtist && (
            <SearchBar
              onSearch={handleSearch}
              isLoading={isLoading}
              initialQuery={displayName}
            />
          )}

          {/* Post-claim success banner */}
          {justClaimed && !claimBannerDismissed && (
            <div className="mt-6 p-4 rounded-xl bg-green-500/10 border border-green-500/20">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary mb-1">
                    Your page is live! Share it with your fans.
                  </p>
                  <p className="text-xs text-text-muted mb-3">
                    Let your audience know they can find all your alternative platform links in one place.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleClaimShare}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-primary text-white text-xs font-medium hover:bg-accent-primary/90 transition-colors"
                    >
                      {claimShareCopied ? (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          Link copied!
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                          </svg>
                          Share your page
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => setClaimBannerDismissed(true)}
                      className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="mt-8 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-center">
              {error}
            </div>
          )}

          {/* Results */}
          <div className="mt-8">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="animate-spin rounded-full h-12 w-12 border-2 border-accent-primary border-t-transparent mb-4"></div>
                <p className="text-text-muted">Searching platforms...</p>
              </div>
            ) : isClaimedArtist ? (
              /* Claimed artist profile — clean layout, no search chrome */
              <div className="space-y-4">
                {isEnriching && (
                  <div className="flex items-center gap-2 text-text-muted text-sm mb-2">
                    <div className="w-3 h-3 border-2 border-accent-secondary border-t-transparent rounded-full animate-spin"></div>
                    <span>Loading more sources...</span>
                  </div>
                )}
                {results.map((result) => (
                  <ResultCard
                    key={result.id}
                    result={result}
                  />
                ))}
              </div>
            ) : results.length > 0 ? (
              /* Search results — with count header and save button */
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-text-muted text-sm">
                    Found {results.length} result{results.length !== 1 ? 's' : ''}
                  </p>
                  {isEnriching && (
                    <div className="flex items-center gap-2 text-text-muted text-sm">
                      <div className="w-3 h-3 border-2 border-accent-secondary border-t-transparent rounded-full animate-spin"></div>
                      <span>Loading more sources...</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between px-4 pb-2">
                  {primaryArtist && (
                    <button
                      onClick={handleSaveArtist}
                      disabled={!primaryArtist.id}
                      className={`flex items-center gap-1.5 text-sm transition-colors ${
                        isSaved ? 'text-accent-secondary' : 'text-text-muted hover:text-accent-secondary'
                      } disabled:opacity-50 disabled:cursor-not-allowed`
                      }
                    >
                      <svg
                        className={`w-4 h-4 transition-all ${
                          isSaved ? 'fill-accent-secondary' : 'fill-transparent stroke-current'
                        }`
                        }
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                      {isSaved ? 'Saved' : 'Save'}
                    </button>
                  )}
                  <div />
                </div>
                {results.map((result) => (
                  <ResultCard
                    key={result.id}
                    result={result}
                  />
                ))}
              </div>
            ) : !error ? (
              <div className="text-center py-16">
                <p className="text-text-muted text-lg">No results found</p>
                <p className="text-text-muted/70 text-sm mt-2">
                  Try a different search term
                </p>
              </div>
            ) : null}
          </div>

          {/* Claim prompt — only show for non-claimed artists */}
          {!isLoading && results.length > 0 && !isClaimedArtist && (
            <div className="mt-6 p-4 rounded-lg border border-border bg-bg-secondary/50 text-center">
              <p className="text-sm text-text-muted">
                Are you {displayName}?{' '}
                <Link
                  to={`/claim/${slug}`}
                  className="text-accent-primary hover:underline font-medium"
                >
                  Claim your artist page
                </Link>
              </p>
            </div>
          )}

          {/* Mac App Promo - after results */}
          {!isLoading && (
            <div className="mt-8">
              {macAppPromo}
            </div>
          )}
        </div>
      </main>

      <Footer />
      {showLoginInterstitial && primaryArtist && (
        <LoginInterstitial
          artistId={primaryArtist.id}
          artistName={primaryArtist.name}
          onClose={() => setShowLoginInterstitial(false)}
        />
      )}
    </div>
  );
}