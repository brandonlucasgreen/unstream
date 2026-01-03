import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import { Link } from 'react-router-dom';

interface Section {
  title: string;
  content: string;
}

interface ParsedContent {
  intro: string;
  faqTitle: string;
  sections: Section[];
}

function parseContent(text: string): ParsedContent {
  // Split on H1 "# FAQ" to separate intro from FAQ
  const faqMatch = text.match(/^# (.+)$/m);
  const faqIndex = text.search(/^# /m);

  const intro = faqIndex > -1 ? text.slice(0, faqIndex).trim() : text;
  const faqTitle = faqMatch ? faqMatch[1] : 'FAQ';
  const faqContent = faqIndex > -1 ? text.slice(faqIndex) : '';

  // Split FAQ content by H3 headings
  const sections: Section[] = [];
  const h3Regex = /^### (.+)$/gm;
  const matches = [...faqContent.matchAll(h3Regex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const title = match[1];
    const startIndex = match.index! + match[0].length;
    const endIndex = matches[i + 1]?.index ?? faqContent.length;
    const content = faqContent.slice(startIndex, endIndex).trim();
    sections.push({ title, content });
  }

  return { intro, faqTitle, sections };
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

export function AboutPage() {
  const [parsedContent, setParsedContent] = useState<ParsedContent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/about.txt')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load content');
        return res.text();
      })
      .then(text => {
        setParsedContent(parseContent(text));
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
      <nav className="absolute top-4 left-1/2 -translate-x-1/2 md:left-auto md:right-4 md:translate-x-0 flex items-center gap-3 text-sm text-text-secondary">
        <Link to="/" className="hover:text-text-primary transition-colors">
          Home
        </Link>
        <span className="text-text-muted/40 text-xs">&#x2022;</span>
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
          href="https://liberapay.com/brandonlucasgreen/donate"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text-primary transition-colors"
        >
          Donate
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
          ) : parsedContent ? (
            <article>
              {/* Intro section */}
              <div className="prose prose-invert prose-lg max-w-none mb-8">
                <Markdown components={markdownComponents}>
                  {parsedContent.intro}
                </Markdown>
              </div>

              {/* FAQ section */}
              {parsedContent.sections.length > 0 && (
                <div className="mt-8">
                  <h2 className="font-display text-2xl font-semibold text-text-primary mb-6">
                    {parsedContent.faqTitle}
                  </h2>
                  <div className="bg-surface/50 rounded-xl border border-border/50 px-5">
                    {parsedContent.sections.map((section, index) => (
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
            </article>
          ) : null}

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
          Made with love in Massachusetts, USA
        </div>
      </footer>
    </div>
  );
}
