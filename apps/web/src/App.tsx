import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { SearchBar } from './components/SearchBar';
import { ResultCard } from './components/ResultCard';

import { Header } from './components/Header';
import type { SearchResult } from './types';
import { sources, sourceCategories, searchPlatforms, resolveArtistUrl, fetchMusicBrainzData, mergeWithMusicBrainzData } from './services/sources';
import { analytics } from './services/analytics';
import { useAuth } from './contexts/AuthContext';
import { Footer } from './components/Footer';
import { PlatformIcon } from './components/PlatformIcon';
import { faqSections } from './data/faq';
import { markdownToHtml } from './utils/markdownLight';
import { badgeColors } from './utils/colors';
import './index.css';

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
      {isOpen && (
        <div className="pb-4">
          <div
            className="prose prose-sm max-w-none text-text-primary space-y-3 [&_a]:text-accent-primary [&_a]:hover:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1"
            dangerouslySetInnerHTML={{ __html: markdownToHtml(content) }}
          />
        </div>
      )}
    </div>
  );
}

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
      {/* Hero — App downloads first */}
      <div className="pt-6 pb-8 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-text-primary">
              Directly support the artist you&rsquo;re listening to right now
            </h1>
            <p className="text-text-secondary text-lg md:text-xl max-w-2xl mx-auto">
              Unstream helps you find the places where music artists you love &amp; listen to keep up to 97% of every sale &mdash; not fractions of a penny from streams.
            </p>
          </div>

          {/* Download CTAs — 2x2 grid */}
          <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
            <a
              href="https://github.com/brandonlucasgreen/unstream/releases/latest"
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#9CA3AF] text-white hover:bg-[#8B92A0] transition-colors font-medium shadow-lg shadow-[#9CA3AF]/20"
              onClick={() => analytics.trackDownload()}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              Download for macOS
            </a>
            <a
              href="https://chromewebstore.google.com/detail/unstream-support-music-di/ghoiopeidkganjdebkgkehaofnmjofkf"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#34A853] text-white hover:bg-[#2d9249] transition-colors font-medium shadow-lg shadow-[#34A853]/20"
              onClick={() => analytics.trackDownloadChrome()}
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
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#FF6611] text-white hover:bg-[#e55b0e] transition-colors font-medium shadow-lg shadow-[#FF6611]/20"
              onClick={() => analytics.trackDownloadFirefox()}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z"/>
              </svg>
              Install for Firefox
            </a>
            <a
              href="https://www.icloud.com/shortcuts/73296296361e4f609087746e7f046d47"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#007AFF] text-white hover:bg-[#0066d6] transition-colors font-medium shadow-lg shadow-[#007AFF]/20"
              onClick={() => analytics.trackDownloadIosShortcut()}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              Install iOS Shortcut
            </a>
          </div>
        </div>
      </div>

      {/* Search section */}
      <main className="px-4 pb-16">
        <div className="max-w-4xl mx-auto">
          <p className="text-text-secondary text-center mb-4">Curious about an artist you love? Search Unstream right here:</p>
          <SearchBar
            onSearch={handleSearch}
            isLoading={isLoading || isResolving}
            initialQuery={resolvedQuery}
            onReset={hasSearched ? handleGoHome : undefined}
          />

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

          {/* Features + Sources */}
          <div className="mt-16 space-y-12">

              {/* App Features */}
              <div className="bg-surface-secondary rounded-2xl p-6 md:p-8 border border-border">
                <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-6 text-center md:text-left">
                  Unstream keeps track of your listening and who you support
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
                    .filter(([key]) => key !== 'social' && key !== 'official' && key !== 'curated') // Social links, official sites, and custom links are discovered per-artist
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
