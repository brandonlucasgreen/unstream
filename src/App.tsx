import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { SearchBar } from './components/SearchBar';
import { ResultCard } from './components/ResultCard';
import type { SearchResult } from './types';
import { sources, sourceCategories, searchPlatforms } from './services/sources';
import './index.css';

function App() {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = useCallback(async (query: string) => {
    setIsLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      // Search all platforms in parallel
      const response = await searchPlatforms(query);
      setResults(response.results);
    } catch (err) {
      setError('Failed to search. Please try again.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleGoHome = useCallback(() => {
    setResults([]);
    setHasSearched(false);
    setError(null);
  }, []);

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="pt-16 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-4xl md:text-5xl font-bold mb-4">
            <button
              onClick={handleGoHome}
              className="text-text-primary hover:opacity-80 transition-opacity cursor-pointer"
            >
              Unstream 🤘🏻
            </button>
          </h1>
          <p className="text-text-secondary text-lg md:text-xl max-w-2xl mx-auto mb-8">
            Find music on alternative platforms, directly support the artists you love, and move off streaming.{' '}
            <Link to="/about" className="text-accent-secondary hover:underline">
              Learn more
            </Link>
          </p>
        </div>
      </header>

      {/* Search */}
      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <SearchBar onSearch={handleSearch} isLoading={isLoading} />

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
                  <p className="text-text-muted text-sm">
                    Found {results.length} result{results.length !== 1 ? 's' : ''}
                  </p>
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
                <p className="text-text-secondary">
                  We search these ethical platforms for your music
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-6">
                {Object.entries(sourceCategories).map(([key, category]) => (
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

            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-8 px-4">
        <div className="max-w-4xl mx-auto text-center text-text-muted text-sm">
          <p>
            Unstream searches ethical music platforms directly. Not affiliated with any listed platforms.
          </p>
          <p className="mt-2 text-text-muted/70">
            Made with love by{' '}
            <a
              href="https://bgreen.lol"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-secondary hover:underline"
            >
              brandon lucas green
            </a>
            {' | '}
            <Link
              to="/about"
              className="text-accent-secondary hover:underline"
            >
              About
            </Link>
            {' | '}
            <Link
              to="/roadmap"
              className="text-accent-secondary hover:underline"
            >
              Roadmap
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}

export default App;
