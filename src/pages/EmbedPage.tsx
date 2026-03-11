import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

const BASE_URL = 'https://unstream.stream';

export function EmbedPage() {
  const [searchParams] = useSearchParams();
  const [artistName, setArtistName] = useState(searchParams.get('artist') || '');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [maxLinks, setMaxLinks] = useState(6);
  const [copied, setCopied] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);

  const embedCode = `<div class="unstream-widget" data-artist="${artistName}" data-theme="${theme}" data-max-links="${maxLinks}"></div>
<script src="${BASE_URL}/widget.js" async></script>`;

  function handleCopy() {
    navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Live preview using the actual widget.js
  useEffect(() => {
    if (!artistName || !previewRef.current) return;

    const container = previewRef.current;
    container.innerHTML = '';

    const widgetEl = document.createElement('div');
    widgetEl.className = 'unstream-widget';
    widgetEl.setAttribute('data-artist', artistName);
    widgetEl.setAttribute('data-theme', theme);
    widgetEl.setAttribute('data-max-links', String(maxLinks));
    container.appendChild(widgetEl);

    // Load widget script
    const script = document.createElement('script');
    script.src = '/widget.js';
    script.async = true;
    container.appendChild(script);

    return () => {
      container.innerHTML = '';
    };
  }, [previewKey]);

  function handlePreview() {
    setPreviewKey((k) => k + 1);
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="pt-8 pb-8 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="font-display text-4xl md:text-5xl font-bold mb-4">
            <Link
              to="/"
              className="text-text-primary hover:opacity-80 transition-opacity"
            >
              Unstream 🤘🏻
            </Link>
          </h1>
          <h2 className="font-display text-2xl md:text-3xl font-semibold text-text-primary mb-3">
            Embeddable Widget
          </h2>
          <p className="text-text-secondary text-lg max-w-xl mx-auto">
            Add a "Find me off streaming" badge to your website. Show fans where to support you directly.
          </p>
        </div>
      </header>

      <main className="px-4 pb-16">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Configuration */}
          <div className="bg-bg-card border border-border rounded-2xl p-6 space-y-5">
            <h3 className="font-display text-lg font-semibold text-text-primary">
              Configure your widget
            </h3>

            {/* Artist name */}
            <div>
              <label className="block text-text-secondary text-sm mb-2">
                Artist name
              </label>
              <input
                type="text"
                value={artistName}
                onChange={(e) => setArtistName(e.target.value)}
                placeholder="e.g. Birdy"
                className="search-input w-full"
              />
            </div>

            {/* Theme */}
            <div>
              <label className="block text-text-secondary text-sm mb-2">
                Theme
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => setTheme('dark')}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    theme === 'dark'
                      ? 'border-accent-primary bg-accent-primary/10 text-accent-primary'
                      : 'border-border text-text-secondary hover:border-border-hover'
                  }`}
                >
                  Dark
                </button>
                <button
                  onClick={() => setTheme('light')}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    theme === 'light'
                      ? 'border-accent-primary bg-accent-primary/10 text-accent-primary'
                      : 'border-border text-text-secondary hover:border-border-hover'
                  }`}
                >
                  Light
                </button>
              </div>
            </div>

            {/* Max links */}
            <div>
              <label className="block text-text-secondary text-sm mb-2">
                Max platform links: {maxLinks}
              </label>
              <input
                type="range"
                min="3"
                max="12"
                value={maxLinks}
                onChange={(e) => setMaxLinks(Number(e.target.value))}
                className="w-full accent-accent-primary"
              />
            </div>

            {/* Preview button */}
            <button
              onClick={handlePreview}
              disabled={!artistName.trim()}
              className="px-5 py-2.5 rounded-xl bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Preview widget
            </button>
          </div>

          {/* Live Preview */}
          <div className="bg-bg-card border border-border rounded-2xl p-6">
            <h3 className="font-display text-lg font-semibold text-text-primary mb-4">
              Preview
            </h3>
            <div
              ref={previewRef}
              className="flex justify-center"
              style={{
                backgroundColor: theme === 'light' ? '#f0f0f0' : '#0d0d0d',
                borderRadius: '8px',
                padding: '24px',
                minHeight: '120px',
              }}
            >
              {!artistName && (
                <p className="text-text-muted text-sm self-center">
                  Enter an artist name and click Preview
                </p>
              )}
            </div>
          </div>

          {/* Embed Code */}
          {artistName.trim() && (
            <div className="bg-bg-card border border-border rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-display text-lg font-semibold text-text-primary">
                  Embed code
                </h3>
                <button
                  onClick={handleCopy}
                  className="px-4 py-1.5 rounded-lg bg-accent-primary/10 text-accent-primary text-sm font-medium hover:bg-accent-primary/20 transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="bg-bg-primary border border-border rounded-lg p-4 overflow-x-auto text-sm text-text-secondary font-mono whitespace-pre-wrap break-all">
                {embedCode}
              </pre>
              <p className="text-text-muted text-xs mt-3">
                Paste this into your website's HTML. The widget loads asynchronously and won't slow down your page.
              </p>
            </div>
          )}

          {/* How it works */}
          <div className="bg-bg-card border border-border rounded-2xl p-6">
            <h3 className="font-display text-lg font-semibold text-text-primary mb-4">
              How it works
            </h3>
            <ul className="space-y-3 text-text-secondary text-sm">
              <li className="flex gap-3">
                <span className="text-accent-primary font-semibold">1.</span>
                The widget loads your artist data from Unstream's database.
              </li>
              <li className="flex gap-3">
                <span className="text-accent-primary font-semibold">2.</span>
                It displays a compact card with your platform links (Bandcamp, Patreon, etc.) in an isolated container that won't affect your site's styles.
              </li>
              <li className="flex gap-3">
                <span className="text-accent-primary font-semibold">3.</span>
                If your artist isn't in the database yet, the widget will search for you in real time.
              </li>
              <li className="flex gap-3">
                <span className="text-accent-primary font-semibold">4.</span>
                Fans click through to your pages on each platform — no middleman.
              </li>
            </ul>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-6 px-4">
        <div className="max-w-3xl mx-auto flex flex-col items-center justify-center gap-3 text-text-secondary text-sm">
          <span>Made with love in Massachusetts, USA</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <Link to="/" className="hover:text-text-primary transition-colors">
              Home
            </Link>
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
          </nav>
        </div>
      </footer>
    </div>
  );
}
