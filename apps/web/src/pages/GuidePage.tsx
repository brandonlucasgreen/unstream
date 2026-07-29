import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { Skeleton, SkeletonScreen } from '../components/Skeleton';
import { ArticleSkeleton } from '../components/LoadingSkeletons';
import { DEFAULT_PAGE_TITLE } from '../data/seo';

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
        const stripped = md.replace(/^---\n[\s\S]*?\n---\n*/, '');
        setContent(stripped);
        const guideMeta = manifest.find(g => g.slug === slug) || null;
        setMeta(guideMeta);

        if (guideMeta) {
          document.title = `${guideMeta.title} - Unstream`;
          const descTag = document.querySelector('meta[name="description"]');
          if (descTag) descTag.setAttribute('content', guideMeta.description);
        }
      })
      .catch((e) => { Sentry.captureException(e, { extra: { context: 'guide.fetchContent' } }); setError(true) });

    return () => {
      document.title = DEFAULT_PAGE_TITLE;
      const descTag = document.querySelector('meta[name="description"]');
      if (descTag) descTag.setAttribute('content', 'Search any artist and find where to support them directly on alternative platforms like Bandcamp, Mirlo, and more.');
    };
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

  const pageUrl = `https://unstream.stream/guides/${slug}`;

  return (
    <div className="min-h-screen">

      <Header />
      <div className="pt-6 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          {!meta && (
            <div className="flex flex-col items-center gap-3">
              <Skeleton className="h-9 w-3/4 max-w-md" />
              <Skeleton className="h-4 w-2/3 max-w-sm" />
            </div>
          )}
          {meta && (
            <>
              <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-2">
                {meta.title}
              </h1>
              <p className="text-text-secondary mb-3">{meta.description}</p>
              <p className="text-text-muted text-sm">
                By <a href="https://bgreen.lol" target="_blank" rel="noopener noreferrer" className="text-text-secondary hover:text-text-primary transition-colors">Brandon Lucas Green</a> — musician, builder of Unstream
              </p>
            </>
          )}
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto">
          {content === null ? (
            <SkeletonScreen label="Loading guide">
              <ArticleSkeleton />
            </SkeletonScreen>
          ) : (
            <>
              {meta && (
                <script
                  type="application/ld+json"
                  dangerouslySetInnerHTML={{
                    __html: JSON.stringify({
                      '@context': 'https://schema.org',
                      '@type': 'Article',
                      'headline': meta.title,
                      'description': meta.description,
                      'datePublished': meta.published,
                      'url': pageUrl,
                      'author': {
                        '@type': 'Person',
                        'name': 'Brandon Lucas Green',
                        'url': 'https://bgreen.lol',
                      },
                      'publisher': {
                        '@type': 'Organization',
                        'name': 'Unstream',
                        'url': 'https://unstream.stream',
                      },
                    }),
                  }}
                />
              )}
              <article className="prose prose-neutral dark:prose-invert max-w-none
                prose-headings:font-display prose-headings:text-text-primary
                prose-p:text-text-secondary prose-a:text-accent-primary
                prose-li:text-text-secondary prose-strong:text-text-primary">
                <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
              </article>
            </>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
