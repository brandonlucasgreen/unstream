import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { Header } from '../components/Header';
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
      <Header />
      <div className="pt-6 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          {meta && (
            <>
              <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-2">
                {meta.title}
              </h1>
              <p className="text-text-secondary">{meta.description}</p>
            </>
          )}
        </div>
      </div>

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
