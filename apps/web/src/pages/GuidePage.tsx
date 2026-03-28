import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import { ThemeToggle } from '../components/ThemeToggle';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { useTheme } from '../hooks/useTheme';
import { Footer } from '../components/Footer';

interface GuideMeta {
  slug: string;
  title: string;
  description: string;
  pillar: string;
  published: string;
}

export function GuidePage() {
  const { slug } = useParams<{ slug: string }>();
  const { preference, cycleTheme } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [meta, setMeta] = useState<GuideMeta | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!slug) return;

    Promise.all([
      fetch(`/data/guides/${slug}.md`).then(res => {
        if (!res.ok) throw new Error('Not found');
        return res.text();
      }),
      fetch('/data/guides/guides-manifest.json').then(res => res.json()),
    ])
      .then(([md, manifest]: [string, GuideMeta[]]) => {
        // Strip YAML frontmatter before rendering
        const stripped = md.replace(/^---\n[\s\S]*?\n---\n*/, '');
        setContent(stripped);
        setMeta(manifest.find(g => g.slug === slug) || null);
      })
      .catch(() => setError(true));
  }, [slug]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-text-primary mb-2">Not found</h1>
          <Link to="/guides" className="text-accent-primary hover:underline">Back to guides</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <ArtistAuthBar />
      <header className="pt-8 pb-8 px-4 relative">
        <div className="absolute top-4 right-4">
          <ThemeToggle preference={preference} onCycle={cycleTheme} />
        </div>
        <div className="max-w-4xl mx-auto text-center">
          <Link
            to="/guides"
            className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            All guides
          </Link>
          {meta && (
            <>
              <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-2">
                {meta.title}
              </h1>
              <p className="text-text-secondary">{meta.description}</p>
            </>
          )}
        </div>
      </header>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto">
          {content === null ? (
            <p className="text-text-muted text-center">Loading...</p>
          ) : (
            <article className="prose prose-neutral dark:prose-invert max-w-none
              prose-headings:font-display prose-headings:text-text-primary
              prose-p:text-text-secondary prose-a:text-accent-primary
              prose-li:text-text-secondary prose-strong:text-text-primary">
              <Markdown>{content}</Markdown>
            </article>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
