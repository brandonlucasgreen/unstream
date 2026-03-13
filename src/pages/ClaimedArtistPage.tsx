import { useState, useEffect, useRef } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { sources } from '../services/sources';
import { SocialIcon, hasSocialIcon } from '../components/SocialIcon';
import type { SourceId } from '../types';

interface ArtistProfile {
  bio?: string;
  customImageUrl?: string;
  websiteUrl?: string;
  verified: boolean;
}

interface PlatformLink {
  sourceId: string;
  url: string;
}

interface ArtistData {
  id: string;
  name: string;
  imageUrl?: string;
  platforms: PlatformLink[];
  matchConfidence?: string;
  profile?: ArtistProfile;
}

function EmbedSection({ artistName }: { artistName: string }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [maxLinks, setMaxLinks] = useState(6);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const embedCode = `<div class="unstream-widget" data-artist="${artistName}" data-theme="${theme}" data-max-links="${maxLinks}"></div>\n<script src="https://unstream.stream/widget.js" async></script>`;

  function handleCopy() {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Load live preview when section is opened
  useEffect(() => {
    if (!open || !previewRef.current) return;

    const container = previewRef.current;
    container.innerHTML = '';

    const widgetEl = document.createElement('div');
    widgetEl.className = 'unstream-widget';
    widgetEl.setAttribute('data-artist', artistName);
    widgetEl.setAttribute('data-theme', theme);
    widgetEl.setAttribute('data-max-links', String(maxLinks));
    container.appendChild(widgetEl);

    const script = document.createElement('script');
    script.src = '/widget.js';
    script.async = true;
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, [open, theme, maxLinks, artistName]);

  return (
    <div className="w-full max-w-2xl mx-auto px-6 pb-8">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors"
      >
        <svg
          className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        Embed this profile on your website
      </button>

      {open && (
        <div className="mt-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
          {/* Options row */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">Theme:</span>
              <button
                onClick={() => setTheme('dark')}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  theme === 'dark'
                    ? 'bg-accent-primary/15 text-accent-primary'
                    : 'bg-bg-secondary text-text-muted hover:text-text-primary'
                }`}
              >
                Dark
              </button>
              <button
                onClick={() => setTheme('light')}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  theme === 'light'
                    ? 'bg-accent-primary/15 text-accent-primary'
                    : 'bg-bg-secondary text-text-muted hover:text-text-primary'
                }`}
              >
                Light
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">Links: {maxLinks}</span>
              <input
                type="range"
                min="3"
                max="12"
                value={maxLinks}
                onChange={(e) => setMaxLinks(Number(e.target.value))}
                className="w-20 accent-accent-primary"
              />
            </div>
          </div>

          {/* Live preview */}
          <div
            className="rounded-lg overflow-hidden"
            style={{
              backgroundColor: theme === 'light' ? '#f0f0f0' : '#0d0d0d',
              padding: '16px',
            }}
          >
            <div ref={previewRef} className="flex justify-center" />
          </div>

          {/* Code block */}
          <div className="relative">
            <pre className="bg-bg-secondary border border-border rounded-lg p-4 overflow-x-auto text-xs text-text-muted font-mono whitespace-pre-wrap break-all">
              {embedCode}
            </pre>
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 px-3 py-1 rounded text-xs font-medium bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <p className="text-xs text-text-muted">
            Paste this into your website's HTML. The widget loads asynchronously and won't affect your page speed.
          </p>
        </div>
      )}
    </div>
  );
}

export function ClaimedArtistPage() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const [artist, setArtist] = useState<ArtistData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [pending, setPending] = useState(false);

  const displayName = artist?.name || slug?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || '';

  // Check if we arrived from the claim flow (freshly claimed)
  const justClaimed = new URLSearchParams(location.search).has('claimed');

  useEffect(() => {
    if (!slug) return;

    let retries = justClaimed ? 3 : 0;

    function fetchArtist() {
      // Cache-bust when freshly claimed to avoid stale CDN responses
      const cacheBust = justClaimed ? `&_t=${Date.now()}` : '';
      fetch(`/api/artist?slug=${encodeURIComponent(slug!)}${cacheBust}`)
        .then(r => {
          if (!r.ok) throw new Error('not found');
          return r.json();
        })
        .then((data: ArtistData) => {
          if (data.matchConfidence === 'claimed' && data.profile?.verified) {
            setArtist(data);
            setLoading(false);
          } else if (retries > 0) {
            // DB might not have propagated yet, retry after a short delay
            retries--;
            setTimeout(fetchArtist, 1000);
          } else if (data.profile && !data.profile.verified) {
            setPending(true);
            setLoading(false);
          } else {
            setNotFound(true);
            setLoading(false);
          }
        })
        .catch(() => {
          if (retries > 0) {
            retries--;
            setTimeout(fetchArtist, 1000);
          } else {
            setNotFound(true);
            setLoading(false);
          }
        });
    }

    fetchArtist();
  }, [slug, justClaimed]);

  useEffect(() => {
    if (artist) {
      document.title = `${artist.name} - Unstream`;
    }
  }, [artist]);

  // Filter to only direct platform links (exclude search URLs)
  const directPlatforms = artist?.platforms.filter(p => {
    const url = p.url.toLowerCase();
    return !url.includes('duckduckgo.com') &&
      !url.includes('google.com/search') &&
      !url.includes('searchstyle=search') &&
      !url.includes('explore-creators');
  }) || [];

  // Separate marketplace/patronage from social/other
  const mainPlatforms = directPlatforms.filter(p => {
    const source = sources[p.sourceId as SourceId];
    return source && ['marketplace', 'patronage', 'library', 'decentralized', 'official'].includes(source.category);
  });
  const socialPlatforms = directPlatforms.filter(p => {
    const source = sources[p.sourceId as SourceId];
    return source?.category === 'social';
  });

  const imageUrl = artist?.profile?.customImageUrl || artist?.imageUrl;

  if (loading) {
    return (
      <div className="min-h-screen bg-bg-primary text-text-primary flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Pending verification shell
  if (pending) {
    return (
      <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
        <header className="p-4 border-b border-border">
          <Link to="/" className="text-xl font-bold text-accent-primary hover:opacity-80 transition-opacity">
            Unstream
          </Link>
        </header>
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-4 max-w-sm">
            <div className="text-4xl">⏳</div>
            <h1 className="text-xl font-bold">{displayName}</h1>
            <p className="text-text-muted text-sm">
              This artist page is being set up and is pending verification.
              Check back soon.
            </p>
            <Link
              to={`/artist/${slug}`}
              className="inline-block text-sm text-accent-primary hover:underline"
            >
              View search results for {displayName}
            </Link>
          </div>
        </main>
        <footer className="p-4 text-center text-xs text-text-muted border-t border-border">
          <Link to="/" className="hover:text-text-primary transition-colors">Powered by Unstream</Link>
        </footer>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
        <header className="p-4 border-b border-border">
          <Link to="/" className="text-xl font-bold text-accent-primary hover:opacity-80 transition-opacity">
            Unstream
          </Link>
        </header>
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-4">
            <h1 className="text-xl font-bold">Artist page not found</h1>
            <p className="text-text-muted text-sm">
              This artist hasn't claimed their Unstream profile yet.
            </p>
            <Link
              to={`/artist/${slug}`}
              className="inline-block text-sm text-accent-primary hover:underline"
            >
              Search for {displayName} instead
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      {/* Hero Section */}
      <div className="w-full max-w-2xl mx-auto px-6 pt-12 pb-8">
        <div className="flex flex-col items-center text-center space-y-4">
          {imageUrl && (
            <img
              src={imageUrl}
              alt={artist!.name}
              className="w-32 h-32 rounded-full object-cover border-2 border-border"
            />
          )}
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2">
              <h1 className="text-3xl font-bold">{artist!.name}</h1>
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-accent-primary/15 text-accent-primary"
                title="Verified artist"
              >
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Claimed
              </span>
            </div>
            {artist!.profile?.bio && (
              <p className="text-text-muted text-sm max-w-md">{artist!.profile.bio}</p>
            )}
          </div>
        </div>
      </div>

      {/* Platform Links */}
      <div className="w-full max-w-2xl mx-auto px-6 pb-8">
        {mainPlatforms.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-xs font-medium text-text-muted uppercase tracking-wider">
              Support directly
            </h2>
            <div className="grid gap-2">
              {mainPlatforms.map(platform => {
                const source = sources[platform.sourceId as SourceId];
                if (!source) return null;
                return (
                  <a
                    key={platform.sourceId}
                    href={platform.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border hover:border-transparent transition-all"
                    style={{
                      backgroundColor: `${source.color}08`,
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = `${source.color}18`;
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLElement).style.backgroundColor = `${source.color}08`;
                    }}
                  >
                    <span className="text-xl">{source.icon}</span>
                    <span className="font-medium flex-1">{source.name}</span>
                    {source.artistPayoutPercent && (
                      <span className="text-xs text-text-muted">
                        {source.artistPayoutPercent} to artist
                      </span>
                    )}
                    <svg className="w-4 h-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {/* Social Links */}
        {socialPlatforms.length > 0 && (
          <div className="mt-8 space-y-3">
            <h2 className="text-xs font-medium text-text-muted uppercase tracking-wider">
              Follow
            </h2>
            <div className="flex flex-wrap gap-2">
              {socialPlatforms.map(platform => {
                const source = sources[platform.sourceId as SourceId];
                if (!source) return null;
                return (
                  <a
                    key={platform.sourceId}
                    href={platform.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-bg-secondary transition-colors text-sm"
                  >
                    {hasSocialIcon(platform.sourceId) ? (
                      <SocialIcon platform={platform.sourceId as SourceId} />
                    ) : (
                      <span>{source.icon}</span>
                    )}
                    <span>{source.name}</span>
                  </a>
                );
              })}
            </div>
          </div>
        )}

        {/* Website Link */}
        {artist!.profile?.websiteUrl && (
          <div className="mt-8 space-y-3">
            <h2 className="text-xs font-medium text-text-muted uppercase tracking-wider">
              Website
            </h2>
            <a
              href={artist!.profile.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-accent-primary hover:underline"
            >
              {new URL(artist!.profile.websiteUrl).hostname.replace(/^www\./, '')}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        )}
      </div>

      {/* Embed Section */}
      <EmbedSection artistName={artist!.name} />

      {/* Footer */}
      <footer className="mt-auto border-t border-border py-6 px-4">
        <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
          <span>Made with love in Massachusetts, USA</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <a href="https://unstream.featurebase.app/roadmap" target="_blank" rel="noopener noreferrer" className="hover:text-text-primary transition-colors">Roadmap</a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <a href="mailto:support@unstream.stream" className="hover:text-text-primary transition-colors">Support</a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <a href="https://unstream.goatcounter.com" target="_blank" rel="noopener noreferrer" className="hover:text-text-primary transition-colors">Metrics</a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <a href="https://liberapay.com/brandonlucasgreen/donate" target="_blank" rel="noopener noreferrer" className="hover:text-text-primary transition-colors">Donate</a>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <Link to="/privacy-policy" className="hover:text-text-primary transition-colors">Privacy</Link>
            <span className="text-text-muted/40 text-xs">&#x2022;</span>
            <Link to={`/claim/${slug}`} className="hover:text-text-primary transition-colors">Artist login</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
