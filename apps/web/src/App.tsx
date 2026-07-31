import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { SearchBar } from './components/SearchBar';
import { ResultCard } from './components/ResultCard';

import { Header } from './components/Header';
import { LoadingLabel, SkeletonScreen } from './components/Skeleton';
import { SearchResultsSkeleton } from './components/LoadingSkeletons';
import type { SearchResult } from './types';
import { sources, sourceCategories, searchPlatforms, resolveArtistUrl, fetchMusicBrainzData, mergeWithMusicBrainzData, buildMusicBrainzFallbackResult } from './services/sources';
import { analytics } from './services/analytics';
import { useAuth } from './contexts/AuthContext';
import { DownloadGrid } from './components/DownloadGrid';
import { ScreenshotCarousel } from './components/ScreenshotCarousel';
import { Footer } from './components/Footer';
import { PlatformIcon } from './components/PlatformIcon';
import { badgeColors } from './utils/colors';
import { DEFAULT_PAGE_TITLE } from './data/seo';
import './index.css';

function App() {
  const { isAdmin, session, loadSavedArtists } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState<string>('');
  const [isResolving, setIsResolving] = useState(false);
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());

  // PWA standalone detection — hide hero/download section when in app mode
  // Initialize synchronously to avoid flash of wrong content
  const [isStandalone] = useState(() =>
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
     (navigator as any).standalone === true)
  );

  // Load saved artists when session is available (needed for ResultCard save buttons)
  useEffect(() => {
    if (session) loadSavedArtists();
  }, [session]);

  // PWA: redirect logged-in users to dashboard on app launch
  useEffect(() => {
    if (isStandalone && session && !searchParams.get('q') && !searchParams.get('url')) {
      navigate('/dashboard', { replace: true });
    }
  }, [isStandalone, session]);

  // Track current search to handle race conditions
  const currentSearchRef = useRef<number>(0);
  // Track if we just went home to prevent re-triggering search from stale URL
  const justWentHomeRef = useRef(false);
  // The last query we actually searched for. The header search bar navigates to
  // /?q=… from anywhere in the app, so ?q= has to be able to change on a page
  // that has already searched — comparing against this is what makes a second
  // search (and the back button between two searches) work.
  const lastSearchedRef = useRef<string>('');
  const letterbirdRef = useRef<HTMLDivElement>(null);

  // Update page title based on search query
  useEffect(() => {
    const query = searchParams.get('q');
    if (query) {
      document.title = `${query} on Unstream - Find where to support them`;
    } else {
      document.title = DEFAULT_PAGE_TITLE;
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
    // Handle direct query param (e.g., ?q=radiohead). The guard is "is this a
    // different query than the one we ran" rather than "have we searched at
    // all": the old !hasSearched check only ever allowed the first search, so a
    // second search from the header would change the URL and nothing else.
    else if (queryParam && queryParam !== lastSearchedRef.current && !isResolving) {
      setResolvedQuery(queryParam);
      handleSearch(queryParam);
    }
    // Bare / with results still on screen: the user clicked the Unstream logo,
    // which reads as "go home", or used the back button to a URL with no query.
    // Same source-of-truth rule as above — no ?q= means nothing to show. This
    // resets state only; the URL is already where we want it, so it must not
    // write to searchParams (setting an already-empty query can no-op, which
    // would leave justWentHomeRef armed and swallow the next real search).
    else if (!urlParam && !queryParam && hasSearched && !isResolving) {
      resetSearchState();
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
    lastSearchedRef.current = query;

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

      // Phase 2: MusicBrainz enrichment (runs in background). Also runs when
      // Phase 1 found NOTHING — MusicBrainz may still know the artist, and an
      // official-site card beats an empty results page. Skipping Phase 2 on
      // zero results was why major artists could look like they don't exist.
      if (response.hasPendingEnrichment) {
        setIsEnriching(true);

        try {
          const mbData = await fetchMusicBrainzData(query);

          // Check if this is still the current search before updating
          if (currentSearchRef.current === searchId && mbData) {
            setResults(prev => {
              if (prev.length > 0) return mergeWithMusicBrainzData(prev, mbData);
              const fallback = buildMusicBrainzFallbackResult(mbData);
              return fallback ? [fallback] : prev;
            });
          }
        } catch (enrichErr) {
          Sentry.captureException(enrichErr, { extra: { context: 'search.musicbrainzEnrichment' } });
          console.error('MusicBrainz enrichment failed:', enrichErr);
        } finally {
          if (currentSearchRef.current === searchId) {
            setIsEnriching(false);
          }
        }
      }
    } catch (err) {
      Sentry.captureException(err, { extra: { context: 'search.platformSearch' } });
      if (currentSearchRef.current === searchId) {
        setError('Failed to search. Please try again.');
        setIsLoading(false);
      }
      console.error(err);
    }
  }, [setSearchParams]);

  // Clear everything a search produced, without touching the URL. Split out of
  // handleGoHome so the effect above can reset in response to the URL losing its
  // ?q= (logo click, back button) rather than only on an in-page Clear.
  const resetSearchState = useCallback(() => {
    lastSearchedRef.current = '';
    setResults([]);
    setHasSearched(false);
    setError(null);
    setResolvedQuery('');
    setIsEnriching(false);
    setSelectedForMerge(new Set());
  }, []);

  const handleGoHome = useCallback(() => {
    // Mark that we're going home to prevent useEffect from re-triggering. That
    // run is swallowed rather than filtered by lastSearchedRef, because the
    // effect can still see the stale ?q= in the same batch as the reset.
    justWentHomeRef.current = true;
    resetSearchState();
    // Clear the URL params when going home
    setSearchParams({}, { replace: true });
  }, [resetSearchState, setSearchParams]);

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedForMerge(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Admin removed a link: drop it locally so the card reflects the change now.
  // The suppression itself is server-side, but the CDN may serve this query's
  // cached response for a few minutes yet.
  const handleLinkRemoved = useCallback((resultId: string, url: string) => {
    setResults(prev => prev.map(r =>
      r.id === resultId
        ? { ...r, platforms: r.platforms.filter(p => p.url !== url) }
        : r
    ));
  }, []);

  const handleMergeSelected = useCallback(() => {
    const selectedResults = results.filter(r => selectedForMerge.has(r.id));
    navigate('/admin/merge', { state: { results: selectedResults } });
  }, [results, selectedForMerge, navigate]);

  return (
    <div className="min-h-screen">

      <Header />

      {/* Hero — pitch copy, so it gives way to results the moment someone
          searches. Leaving it up pushed the first result below the fold on a
          phone. The marketing byline is dropped entirely in PWA mode. */}
      {!hasSearched && (
      <div className={isStandalone ? "pt-20 px-4" : "pt-14 px-4"}>
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-[30px]">
            {/* Darker Grotesque's cap height is ~20% shorter than the body face
                at the same size, so the display sizes are stepped up to keep the
                old optical weight. Mobile stays at text-4xl regardless: the
                bigger step runs the hero to four lines and shoves the download
                buttons toward the fold. */}
            <h1 className="font-display text-4xl md:text-6xl font-extrabold tracking-tight mb-4 text-text-primary">
              Directly support the artist you&rsquo;re listening to <span className="marker-word">right now</span>
            </h1>
            {!isStandalone && (
              <p className="text-text-secondary text-lg md:text-xl max-w-2xl mx-auto">
                Unstream finds the places where your favorite music artists &mdash; not big tech companies &mdash; keep up to 97% of every sale.
              </p>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Search section */}
      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          {isStandalone ? (
            /* App home. Search keeps a prominent input here even though the
               marketing page hands it to the header: there are no download
               links competing for the CTA, and launching the installed app onto
               a screen with no input to type in is a dead end. Signed-in users
               never see this — they're redirected to /dashboard above. */
            <div className="space-y-6">
              <SearchBar
                onSearch={handleSearch}
                isLoading={isLoading || isResolving}
                initialQuery={resolvedQuery}
                onReset={hasSearched ? handleGoHome : undefined}
              />
              {!session && (
                <p className="text-center">
                  <Link to="/login" className="text-accent-primary hover:underline font-medium">
                    Sign in to save artists &rarr;
                  </Link>
                </p>
              )}
            </div>
          ) : !hasSearched && (
            <>
              {/* Download buttons — the homepage's primary CTA now that search
                  lives in the header on every page. Hidden once there are
                  results to show, along with the hero above. */}
              <div className="mb-[30px]">
                <DownloadGrid />
              </div>

              <p className="text-center text-text-secondary">
                Or search artists anytime at the top of the page 🔎
              </p>
            </>
          )}

          {/* Resolving URL state */}
          {isResolving && (
            <div className="mt-8 flex items-center justify-center py-8">
              <LoadingLabel>Resolving artist from link...</LoadingLabel>
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
                <SkeletonScreen label="Searching platforms">
                  <div className="space-y-4">
                    <LoadingLabel>Searching platforms...</LoadingLabel>
                    <SearchResultsSkeleton />
                  </div>
                </SkeletonScreen>
              ) : results.length > 0 ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-text-muted text-sm">
                      Found {results.length} result{results.length !== 1 ? 's' : ''}
                    </p>
                    <div className="flex items-center gap-4">
                      {isEnriching && <LoadingLabel>Loading more sources...</LoadingLabel>}
                      {/* In PWA mode the SearchBar's own Reset already does this. */}
                      {!isStandalone && (
                        <button
                          onClick={handleGoHome}
                          className="text-sm text-text-muted hover:text-text-primary transition-colors shrink-0"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  {results.map((result) => (
                    <ResultCard
                      key={result.id}
                      result={result}
                      isAdmin={isAdmin}
                      isSelected={selectedForMerge.has(result.id)}
                      onToggleSelect={handleToggleSelect}
                      onLinkRemoved={handleLinkRemoved}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-16">
                  <p className="text-text-muted text-lg">No results found</p>
                  <p className="text-text-muted/70 text-sm mt-2">
                    Try a different search term
                  </p>
                  {!isStandalone && (
                    <button
                      onClick={handleGoHome}
                      className="mt-4 text-sm text-text-muted hover:text-text-primary transition-colors"
                    >
                      Clear
                    </button>
                  )}
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
                <h2 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-6 text-center md:text-left heading-accent">
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
                    <ScreenshotCarousel />
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
                <h2 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-6 text-center md:text-left heading-accent">
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

          {/* FAQ link — marketing site only; the footer carries FAQ in app mode */}
          {!isStandalone && (
          <div className="text-center mt-8">
            <a href="/faq" className="text-accent-secondary hover:underline font-medium">
              Frequently asked questions →
            </a>
          </div>
          )}
        </div>
      </main>

      {/* Contact Form — marketing site only. Skipping it in app mode also skips
          the third-party Letterbird script, since the effect below finds no
          container to mount into. */}
      {!isStandalone && (
      <section className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
            <h2 className="font-display text-3xl md:text-4xl font-extrabold text-text-primary mb-3 text-center md:text-left heading-accent">
              Get in touch
            </h2>
            <p className="text-text-secondary mb-6 text-center md:text-left">
              Can't find the artist you want to support? Have a feature idea? Reach out below.
            </p>
            <div ref={letterbirdRef}></div>
          </div>
        </div>
      </section>
      )}

      <Footer />
    </div>
  );
}

export default App;
