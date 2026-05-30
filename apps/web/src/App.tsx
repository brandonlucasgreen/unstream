import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { SearchBar } from './components/SearchBar';
import { ResultCard } from './components/ResultCard';

import { Header } from './components/Header';
import type { SearchResult } from './types';
import { sources, sourceCategories, searchPlatforms, resolveArtistUrl, fetchMusicBrainzData, mergeWithMusicBrainzData } from './services/sources';
import { analytics } from './services/analytics';
import { useAuth } from './contexts/AuthContext';
import { DownloadGrid } from './components/DownloadGrid';
import { Footer } from './components/Footer';
import { PlatformIcon } from './components/PlatformIcon';
import { badgeColors } from './utils/colors';
import './index.css';

function App() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState<string>('');
  const [isResolving, setIsResolving] = useState(false);
  const [, setIsFromUrl] = useState(false);
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());

  // PWA standalone detection — hide hero/download section when in app mode
  // Initialize synchronously to avoid flash of wrong content
  const [isStandalone] = useState(() =>
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
     (navigator as any).standalone === true)
  );

  // Track current search to handle race conditions
  const currentSearchRef = useRef<number>(0);
  // Track if we just went home to prevent re-triggering search from stale URL
  const justWentHomeRef = useRef(false);
  const letterbirdRef = useRef<HTMLDivElement>(null);

  // Default page title
  const defaultTitle = 'Unstream - Find where to buy music directly from artists you love';

  // Update page title based on search query
  useEffect(() => {
    const query = searchParams.get('q');
    if (query) {
      document.title = `${query} on Unstream - Find where to support them`;
    } else {
      document.title = defaultTitle;
    }
  }, [searchParams]);

  // FAQ content is now statically imported from ./data/faq.ts

  // Handle URL parameters for deep-linked searches
  useEffect(() => {
    // Skip if we just went home (prevents re-triggering from stale URL)
    if (justWentHomeRef.current) {
      justWentHomeRef.current = false;
      return;
    }

    const urlParam = searchParams.get('url');
    const queryParam = searchParams.get('q');

    // Handle streaming service URL resolution (e.g., ?url=spotify.com/artist/...)
    if (urlParam && !isResolving && !hasSearched) {
      setIsResolving(true);
      setError(null);

      resolveArtistUrl(urlParam).then((result) => {
        if (result) {
          setResolvedQuery(result.artistName);
          setIsFromUrl(true);
          // Update URL to use q param instead
          setSearchParams({ q: result.artistName }, { replace: true });
          // Trigger search with resolved artist name
          handleSearch(result.artistName);
        } else {
          setError('Could not find artist from that link. Try searching manually.');
          setSearchParams({}, { replace: true });
        }
        setIsResolving(false);
      }).catch(() => {
        setError('Failed to resolve link. Try searching manually.');
        setSearchParams({}, { replace: true });
        setIsResolving(false);
      });
    }
    // Handle direct query param (e.g., ?q=radiohead)
    else if (queryParam && !hasSearched && !isResolving) {
      setResolvedQuery(queryParam);
      setIsFromUrl(true);
      handleSearch(queryParam);
    }
  }, [searchParams, isResolving, hasSearched, setSearchParams]);

  // Load Letterbird contact form embed
  useEffect(() => {
    const el = letterbirdRef.current;
    if (el && !el.querySelector('script')) {
      const script = document.createElement('script');
      script.src = 'https://letterbird.co/embed/v1.js';
      script.setAttribute('data-letterbirduser', 'hi-d2078591');
      el.appendChild(script);
    }
  }, []);

  const handleSearch = useCallback(async (query: string) => {
    // Generate unique ID for this search to handle race conditions
    const searchId = Date.now();
    currentSearchRef.current = searchId;

    setIsLoading(true);
    setIsEnriching(false);
    setError(null);
    setHasSearched(true);

    // Update URL with search query for shareable links
    setSearchParams({ q: query }, { replace: true });

    analytics.trackSearch();

    try {
      // Phase 1: Fast search (returns in ~1-2s without MusicBrainz)
      const response = await searchPlatforms(query);

      // Check if this is still the current search
      if (currentSearchRef.current !== searchId) return;

      setResults(response.results);
      setIsLoading(false);
      analytics.trackSearchResults(response.results.length > 0, response.results.length);

      // Phase 2: MusicBrainz enrichment (runs in background)
      if (response.hasPendingEnrichment && response.results.length > 0) {
        setIsEnriching(true);

        try {
          const mbData = await fetchMusicBrainzData(query);

          // Check if this is still the current search before updating
          if (currentSearchRef.current === searchId && mbData) {
            setResults(prev => mergeWithMusicBrainzData(prev, mbData));
          }
        } catch (enrichErr) {
          // Silent failure for enrichment - don't show error to user
          console.error('MusicBrainz enrichment failed:', enrichErr);
        } finally {
          if (currentSearchRef.current === searchId) {
            setIsEnriching(false);
          }
        }
      }
    } catch (err) {
      if (currentSearchRef.current === searchId) {
        setError('Failed to search. Please try again.');
        setIsLoading(false);
      }
      console.error(err);
    }
  }, [setSearchParams]);

  const handleGoHome = useCallback(() => {
    // Mark that we're going home to prevent useEffect from re-triggering
    justWentHomeRef.current = true;
    setResults([]);
    setHasSearched(false);
    setError(null);
    setResolvedQuery('');
    setIsEnriching(false);
    setIsFromUrl(false);
    setSelectedForMerge(new Set());
    // Clear the URL params when going home
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedForMerge(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleMergeSelected = useCallback(() => {
    const selectedResults = results.filter(r => selectedForMerge.has(r.id));
    navigate('/admin/merge', { state: { results: selectedResults } });
  }, [results, selectedForMerge, navigate]);

  return (
    <div className="min-h-screen">

      <Header />

      {/* Hero — heading always visible, download buttons hidden in PWA mode */}
      <div className={isStandalone ? "pt-12 px-4" : "pt-6 px-4"}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-[30px]">
            <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-text-primary">
              Directly support the artist you&rsquo;re listening to right now
            </h1>
            <p className="text-text-secondary text-lg md:text-xl max-w-2xl mx-auto">
              Unstream finds the places where your favorite music artists &mdash; not big tech companies &mdash; keep up to 97% of every sale.
            </p>
          </div>
        </div>
      </div>

      {/* Search section */}
      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <SearchBar
            onSearch={handleSearch}
            isLoading={isLoading || isResolving}
            initialQuery={resolvedQuery}
            onReset={hasSearched ? handleGoHome : undefined}
          />

          {/* Download buttons — below search, hidden in PWA mode */}
          {!isStandalone && (
          <div className="mt-[30px]">
            <DownloadGrid />
          </div>
          )}

          {/* Resolving URL state */}
          {isResolving && (
            <div className="mt-8 flex flex-col items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent-secondary border-t-transparent mb-3"></div>
              <p className="text-text-muted">Resolving artist from link...</p>
            </div>
          )}

          {/* Error state */}
          {error && (
            <div className="mt-8 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-center">
              {error}
            </div>
          )}

          {/* Results */}
          {hasSearched && !error && (
            <div className="mt-8">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <div className="animate-spin rounded-full h-12 w-12 border-2 border-accent-primary border-t-transparent mb-4"></div>
                  <p className="text-text-muted">Searching platforms...</p>
                </div>
              ) : results.length > 0 ? (
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
                  {results.map((result) => (
                    <ResultCard
                      key={result.id}
                      result={result}
                      isAdmin={isAdmin}
                      isSelected={selectedForMerge.has(result.id)}
                      onToggleSelect={handleToggleSelect}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-16">
                  <p className="text-text-muted text-lg">No results found</p>
                  <p className="text-text-muted/70 text-sm mt-2">
                    Try a different search term
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Admin floating merge button */}
          {isAdmin && selectedForMerge.size >= 2 && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
              <button
                onClick={handleMergeSelected}
                className="px-6 py-3 rounded-xl bg-accent-primary text-white font-medium shadow-lg shadow-accent-primary/30 hover:bg-accent-primary/90 transition-colors flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                Merge {selectedForMerge.size} Artists
              </button>
            </div>
          )}

          {/* Features + Sources — only show on marketing site, not in PWA mode */}
          {!isStandalone && (
          <div className="mt-16 space-y-12">

              {/* App Features */}
              <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
                <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-6 text-center md:text-left">
                  Keep track of artists you want to support
                </h2>
                <div className="flex flex-col md:flex-row items-start gap-8">
                  <div className="flex-1">
                    <div className="grid md:grid-cols-2 gap-6">
                      <div className="flex gap-3">
                        <div className="text-2xl">🎧</div>
                        <div>
                          <h3 className="font-semibold text-text-primary mb-1">Automatic detection</h3>
                          <p className="text-text-muted text-sm">The macOS menu bar app detects what&rsquo;s playing in Spotify, Apple Music, or any media player on your Mac &mdash; no copy-paste needed.</p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <div className="text-2xl">📋</div>
                        <div>
                          <h3 className="font-semibold text-text-primary mb-1">Save artists</h3>
                          <p className="text-text-muted text-sm">Build a list of artists you want to support. The app remembers them so you always know where to buy their music.</p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <div className="text-2xl">🔔</div>
                        <div>
                          <h3 className="font-semibold text-text-primary mb-1">Release alerts</h3>
                          <p className="text-text-muted text-sm">Get notified when artists you follow release new music. Never miss a drop from the artists you care about.</p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <div className="text-2xl">🎵</div>
                        <div>
                          <h3 className="font-semibold text-text-primary mb-1">Scrobbling</h3>
                          <p className="text-text-muted text-sm">The browser extension detects what you&rsquo;re listening to on Spotify Web and other streaming sites and scrobbles it to ListenBrainz.</p>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <div className="text-2xl">🔒</div>
                        <div>
                          <h3 className="font-semibold text-text-primary mb-1">Fully anonymous</h3>
                          <p className="text-text-muted text-sm">No account required. No personal data collected. Only anonymized searches and clicks &mdash; nothing else.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex-shrink-0 w-full md:w-auto flex justify-center md:justify-start">
                    <img
                      src="/unstream-mac-teaser.png"
                      alt="Unstream for macOS showing artist platforms in the menu bar"
                      className="w-full md:w-80 rounded-xl shadow-2xl border border-border"
                    />
                  </div>
                </div>

                <p className="text-text-secondary text-center mt-6">
                  Unstream is free because the point is getting money to artists, not charging you. If you find it useful, consider{' '}
                  <a href="/support" className="text-accent-primary hover:underline">
                    <strong>supporting its development</strong>
                  </a> 🤘
                </p>
              </div>

              <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
                <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-6 text-center md:text-left">
                  Available sources
                </h2>

                <div className="grid md:grid-cols-2 gap-6">
                  {Object.entries(sourceCategories)
                    .filter(([key]) => key !== 'social' && key !== 'official' && key !== 'curated')
                    .map(([key, category]) => (
                    <div key={key}>
                      <h3 className="font-semibold text-text-primary mb-1">{category.name}</h3>
                      <p className="text-text-muted text-sm mb-4">{category.description}</p>
                      <div className="flex flex-wrap gap-2">
                        {category.sources.map(sourceId => {
                          const source = sources[sourceId];
                          const { textColor, bgColor } = badgeColors(source.color);
                          return (
                            <a
                              key={sourceId}
                              href={source.homepageUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all hover:scale-105 hover:shadow-md"
                              style={{
                                backgroundColor: bgColor,
                                color: textColor,
                              }}
                            >
                              <PlatformIcon sourceId={source.id} color={textColor} emoji={source.icon} />
                              <span>{source.name}</span>
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <p className="text-center text-text-muted text-sm mt-6">
                  ...plus official websites and social links
                </p>
              </div>

            </div>
          )}

          {/* FAQ link — always visible */}
          <div className="text-center mt-8">
            <a href="/faq" className="text-accent-secondary hover:underline font-medium">
              Frequently asked questions →
            </a>
          </div>
        </div>
      </main>

      {/* Contact Form */}
      <section className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
            <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-3 text-center md:text-left">
              Get in touch
            </h2>
            <p className="text-text-secondary mb-6 text-center md:text-left">
              Can't find the artist you want to support? Have a feature idea? Reach out below.
            </p>
            <div ref={letterbirdRef}></div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

export default App;
