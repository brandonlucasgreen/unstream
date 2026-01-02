import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import { Link } from 'react-router-dom';

export function RoadmapPage() {
  const [content, setContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/roadmap.txt')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load content');
        return res.text();
      })
      .then(text => {
        setContent(text);
        setIsLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setIsLoading(false);
      });
  }, []);

  return (
    <div className="min-h-screen">
      {/* Top navigation */}
      <nav className="absolute top-4 right-4 flex items-center gap-3 text-sm text-text-muted">
        <Link to="/about" className="hover:text-text-primary transition-colors">
          About/FAQ
        </Link>
        <span className="text-text-muted/40 text-xs">&#x2022;</span>
        <Link to="/roadmap" className="hover:text-text-primary transition-colors">
          Roadmap
        </Link>
        <span className="text-text-muted/40 text-xs">&#x2022;</span>
        <a
          href="mailto:unstream@bgreen.lol?subject=Unstream%20Support"
          className="hover:text-text-primary transition-colors"
        >
          Support
        </a>
      </nav>

      {/* Header */}
      <header className="pt-16 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-4xl md:text-5xl font-bold mb-4">
            <Link
              to="/"
              className="text-text-primary hover:opacity-80 transition-opacity"
            >
              Unstream 🤘🏻
            </Link>
          </h1>
        </div>
      </header>

      {/* Content */}
      <main className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="animate-spin rounded-full h-12 w-12 border-2 border-accent-primary border-t-transparent mb-4"></div>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-center">
              {error}
            </div>
          ) : (
            <article className="prose prose-invert prose-lg max-w-none">
              <Markdown
                components={{
                  // Style headings
                  h1: ({ children }: { children?: ReactNode }) => (
                    <h1 className="font-display text-3xl font-bold text-text-primary mt-8 mb-4">
                      {children}
                    </h1>
                  ),
                  h2: ({ children }: { children?: ReactNode }) => (
                    <h2 className="font-display text-2xl font-semibold text-text-primary mt-8 mb-3">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }: { children?: ReactNode }) => (
                    <h3 className="font-display text-xl font-semibold text-text-primary mt-6 mb-2">
                      {children}
                    </h3>
                  ),
                  // Style paragraphs
                  p: ({ children }: { children?: ReactNode }) => (
                    <p className="text-text-primary/90 leading-relaxed mb-4">
                      {children}
                    </p>
                  ),
                  // Style links
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
                  // Style lists
                  ul: ({ children }: { children?: ReactNode }) => (
                    <ul className="list-disc ml-5 text-text-primary/90 mb-4 space-y-1 [&_ul]:mt-1 [&_ul]:mb-0">
                      {children}
                    </ul>
                  ),
                  li: ({ children }: { children?: ReactNode }) => (
                    <li className="text-text-primary/90">{children}</li>
                  ),
                  // Style emphasis
                  em: ({ children }: { children?: ReactNode }) => (
                    <em className="text-text-primary italic">{children}</em>
                  ),
                  strong: ({ children }: { children?: ReactNode }) => (
                    <strong className="text-text-primary font-semibold">{children}</strong>
                  ),
                }}
              >
                {content}
              </Markdown>
            </article>
          )}

          {/* Back link */}
          <div className="mt-12 text-center">
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-accent-secondary hover:text-accent-primary transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to search
            </Link>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-6 px-4">
        <div className="max-w-4xl mx-auto text-center text-text-muted/70 text-sm">
          Made with love by{' '}
          <a
            href="https://bgreen.lol"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-secondary hover:underline"
          >
            brandon lucas green
          </a>
        </div>
      </footer>
    </div>
  );
}
