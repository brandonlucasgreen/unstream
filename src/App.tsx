import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SearchBar } from './components/SearchBar';
import { ResultCard } from './components/ResultCard';
import type { SearchResult } from './types';
import { sources, sourceCategories, searchPlatforms, resolveArtistUrl, fetchMusicBrainzData, mergeWithMusicBrainzData } from './services/sources';
import { analytics } from './services/analytics';
import './index.css';

function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState<string>('');
  const [isResolving, setIsResolving] = useState(false);

  // Track current search to handle race conditions
  const currentSearchRef = useRef<number>(0);

  // Handle URL parameters for deep-linked searches
  useEffect(() => {
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
    // Handle direct query param (e.g., ?q=radiohead)
    else if (queryParam && !hasSearched && !isResolving) {
      setResolvedQuery(queryParam);
      handleSearch(queryParam);
    }
  }, [searchParams, isResolving, hasSearched, setSearchParams]);

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
    setResults([]);
    setHasSearched(false);
    setError(null);
    setResolvedQuery('');
    setIsEnriching(false);
    // Clear the URL params when going home
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="pt-8 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-4xl md:text-5xl font-bold mb-4">
            <button
              onClick={handleGoHome}
              className="text-text-primary hover:opacity-80 transition-opacity cursor-pointer"
            >
              Unstream 🤘🏻
            </button>
          </h1>
          <p className="text-text-secondary text-lg md:text-xl max-w-2xl mx-auto mb-6">
            Find your favorite music on alternative platforms, directly support the artists you love, and move off streaming.
          </p>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center justify-center gap-3 mb-8">
            <a
              href="https://github.com/brandonlucasgreen/unstream/releases/latest/download/Unstream.dmg"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors font-medium"
              onClick={() => analytics.trackDownload()}
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
              </svg>
              Download for macOS
            </a>
            <Link
              to="/about"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-text-muted/10 text-text-secondary hover:bg-text-muted/20 hover:text-text-primary transition-colors font-medium"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              About / FAQ
            </Link>
          </div>
        </div>
      </header>

      {/* Search */}
      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <SearchBar onSearch={handleSearch} isLoading={isLoading || isResolving} initialQuery={resolvedQuery} />

          {/* Tip text */}
          <p className="text-center text-text-secondary text-sm mt-4">
            Using an iOS device?{' '}
            <a
              href="https://www.icloud.com/shortcuts/73296296361e4f609087746e7f046d47"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-secondary hover:underline"
            >
              Download this shortcut
            </a>
            {' '}and use it with Spotify or Apple Music to easily search your favorite artists on Unstream.
          </p>

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
                    <ResultCard key={result.id} result={result} />
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

          {/* Initial state - source showcase */}
          {!hasSearched && (
            <div className="mt-16 space-y-12">
              <div className="text-center">
                <h2 className="font-display text-2xl font-semibold text-text-primary mb-2">
                  Supported Sources
                </h2>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                {Object.entries(sourceCategories)
                  .filter(([key]) => key !== 'social' && key !== 'official') // Social links and official sites are discovered per-artist
                  .map(([key, category]) => (
                  <div key={key} className="source-card">
                    <h3 className="font-semibold text-text-primary mb-1">{category.name}</h3>
                    <p className="text-text-muted text-sm mb-4">{category.description}</p>
                    <div className="flex flex-wrap gap-2">
                      {category.sources.map(sourceId => {
                        const source = sources[sourceId];
                        return (
                          <a
                            key={sourceId}
                            href={source.homepageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all hover:scale-105 hover:shadow-md"
                            style={{
                              backgroundColor: `${source.color}15`,
                              color: source.color,
                            }}
                          >
                            <span>{source.icon}</span>
                            <span>{source.name}</span>
                          </a>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-center text-text-muted text-sm">
                ...plus official websites and social links
              </p>

            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-6 px-4">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-center gap-3 text-text-secondary text-sm">
          <span>Made with love in Massachusetts, USA</span>
          <span className="hidden md:inline text-text-muted/40">&#x2022;</span>
          <nav className="flex items-center gap-3">
            <a
              href="https://unstream.featurebase.app/roadmap"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-primary transition-colors"
            >
              Roadmap
            </a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <a
              href="mailto:support@unstream.stream"
              className="hover:text-text-primary transition-colors"
            >
              Support
            </a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <Link
              to="/privacy-policy"
              className="hover:text-text-primary transition-colors"
            >
              Privacy
            </Link>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <a
              href="https://liberapay.com/brandonlucasgreen/donate"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-primary transition-colors"
            >
              Donate
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export default App;
