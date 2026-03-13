import { useState, useCallback, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import { SearchBar } from './components/SearchBar';
import { ResultCard } from './components/ResultCard';
import type { SearchResult } from './types';
import { sources, sourceCategories, searchPlatforms, resolveArtistUrl, fetchMusicBrainzData, mergeWithMusicBrainzData } from './services/sources';
import { analytics } from './services/analytics';
import './index.css';

interface FAQSection {
  title: string;
  content: string;
}

function parseFAQContent(text: string): FAQSection[] {
  const sections: FAQSection[] = [];
  const h3Regex = /^### (.+)$/gm;
  const matches = [...text.matchAll(h3Regex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const title = match[1];
    const startIndex = match.index! + match[0].length;
    const endIndex = matches[i + 1]?.index ?? text.length;
    const content = text.slice(startIndex, endIndex).trim();
    sections.push({ title, content });
  }

  return sections;
}

function CollapsibleSection({ title, content, defaultOpen = false }: {
  title: string;
  content: string;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between py-4 text-left group"
      >
        <h3 className="font-display text-lg font-semibold text-text-primary pr-4 group-hover:text-accent-primary transition-colors">
          {title}
        </h3>
        <svg
          className={`w-5 h-5 text-text-muted flex-shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div className={`overflow-hidden transition-all duration-200 ${isOpen ? 'max-h-[2000px] opacity-100 pb-4' : 'max-h-0 opacity-0'}`}>
        <div className="prose prose-invert prose-sm max-w-none">
          <Markdown components={markdownComponents}>
            {content}
          </Markdown>
        </div>
      </div>
    </div>
  );
}

const markdownComponents = {
  p: ({ children }: { children?: ReactNode }) => (
    <p className="text-text-primary/90 leading-relaxed mb-3">
      {children}
    </p>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent-primary hover:text-accent-secondary transition-colors underline"
    >
      {children}
    </a>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1 [&_ul]:mt-1 [&_ul]:mb-0">
      {children}
    </ul>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className="text-text-primary/90">{children}</li>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em className="text-text-primary italic">{children}</em>
  ),
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="text-text-primary font-semibold">{children}</strong>
  ),
};

function ShareButton() {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const url = window.location.href;
    const text = 'Find this artist on alternative platforms with Unstream';

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Unstream', text, url });
        return;
      } catch {
        // User cancelled or share failed, fall through to clipboard
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard failed silently
    }
  };

  return (
    <button
      onClick={handleShare}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
      title="Share these results"
    >
      {copied ? (
        <>
          <svg className="w-4 h-4 text-accent-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-accent-secondary">Link copied!</span>
        </>
      ) : (
        <>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
          <span>Share</span>
        </>
      )}
    </button>
  );
}

function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isEnriching, setIsEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [resolvedQuery, setResolvedQuery] = useState<string>('');
  const [isResolving, setIsResolving] = useState(false);
  const [, setIsFromUrl] = useState(false);
  const [faqSections, setFaqSections] = useState<FAQSection[]>([]);

  // Track current search to handle race conditions
  const currentSearchRef = useRef<number>(0);
  // Track if we just went home to prevent re-triggering search from stale URL
  const justWentHomeRef = useRef(false);

  // Default page title
  const defaultTitle = 'Unstream - Find music on alternative platforms';

  // Update page title based on search query
  useEffect(() => {
    const query = searchParams.get('q');
    if (query) {
      document.title = `${query} on Unstream - Find music on alternative platforms`;
    } else {
      document.title = defaultTitle;
    }
  }, [searchParams]);

  // Load FAQ content
  useEffect(() => {
    fetch('/faq.txt')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load FAQ');
        return res.text();
      })
      .then(text => {
        setFaqSections(parseFAQContent(text));
      })
      .catch(err => {
        console.error('Failed to load FAQ:', err);
      });
  }, []);

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
    // Mark that we're going home to prevent useEffect from re-triggering
    justWentHomeRef.current = true;
    setResults([]);
    setHasSearched(false);
    setError(null);
    setResolvedQuery('');
    setIsEnriching(false);
    setIsFromUrl(false);
    // Clear the URL params when going home
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

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
            Grab the <a href="https://bgreenlol.lemonsqueezy.com/checkout/buy/d4e127a7-2cef-4013-80b8-5d0de691f332" target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline"><strong>Unstream Yearly Pass</strong></a> ($4.99/year) to unlock saved artist lists, new release alerts and more.
          </p>
          <div className="flex flex-col items-center gap-3 mb-2">
            <a
              href="https://github.com/brandonlucasgreen/unstream/releases/latest/download/Unstream.dmg"
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
          <p className="text-text-secondary text-lg md:text-xl max-w-2xl mx-auto">
            Find your favorite music on alternative platforms, directly support the artists you love, and move off streaming.
          </p>
        </div>
      </header>

      {/* Search */}
      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <SearchBar
            onSearch={handleSearch}
            isLoading={isLoading || isResolving}
            initialQuery={resolvedQuery}
            onReset={hasSearched ? handleGoHome : undefined}
          />

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
                    <div className="flex items-center gap-3">
                      {isEnriching && (
                        <div className="flex items-center gap-2 text-text-muted text-sm">
                          <div className="w-3 h-3 border-2 border-accent-secondary border-t-transparent rounded-full animate-spin"></div>
                          <span>Loading more sources...</span>
                        </div>
                      )}
                      <ShareButton />
                    </div>
                  </div>
                  {results.map((result) => (
                    <ResultCard
                      key={result.id}
                      result={result}
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

          {/* Mac App Promo - after results */}
          {hasSearched && !isLoading && (
            <div className="mt-8">
              {macAppPromo}
            </div>
          )}

          {/* Initial state - Mac app promo + source showcase */}
          {!hasSearched && (
            <div className="mt-16 space-y-12">
              {/* Mac App Promo */}
              {macAppPromo}

              <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
                <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-6 text-center md:text-left">
                  Available sources
                </h2>

                <div className="grid md:grid-cols-2 gap-6">
                  {Object.entries(sourceCategories)
                    .filter(([key]) => key !== 'social' && key !== 'official') // Social links and official sites are discovered per-artist
                    .map(([key, category]) => (
                    <div key={key}>
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

                <p className="text-center text-text-muted text-sm mt-6">
                  ...plus official websites and social links
                </p>
              </div>

              {/* FAQ Section */}
              {faqSections.length > 0 && (
                <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
                  <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-6 text-center md:text-left">
                    FAQ
                  </h2>
                  <div className="bg-surface/50 rounded-xl border border-border/50 px-5">
                    {faqSections.map((section, index) => (
                      <CollapsibleSection
                        key={index}
                        title={section.title}
                        content={section.content}
                        defaultOpen={false}
                      />
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
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
            <div
              ref={(el) => {
                if (el && !el.querySelector('script')) {
                  const script = document.createElement('script');
                  script.src = 'https://letterbird.co/embed/v1.js';
                  script.setAttribute('data-letterbirduser', 'hi-d2078591');
                  el.appendChild(script);
                }
              }}
            ></div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-6 px-4">
        <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
          <span>Made with love in Massachusetts, USA</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
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
            <a
              href="https://unstream.goatcounter.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-primary transition-colors"
            >
              Metrics
            </a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <a
              href="https://liberapay.com/brandonlucasgreen/donate"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-text-primary transition-colors"
            >
              Donate
            </a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <Link
              to="/privacy-policy"
              className="hover:text-text-primary transition-colors"
            >
              Privacy
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export default App;
