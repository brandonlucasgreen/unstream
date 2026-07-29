import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { Link } from 'react-router-dom';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { SkeletonScreen } from '../components/Skeleton';
import { ArticleListSkeleton } from '../components/LoadingSkeletons';
import { DEFAULT_PAGE_TITLE } from '../data/seo';

interface GuideEntry {
  slug: string;
  title: string;
  description: string;
  pillar: string;
  published: string;
}

const INDEX_TITLE = 'Guides - Unstream';
const INDEX_DESCRIPTION = 'How streaming payouts work, platforms worth knowing about, and ways to put more money in artists\' pockets.';

export function GuidesIndexPage() {
  const [guides, setGuides] = useState<GuideEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = INDEX_TITLE;
    const descTag = document.querySelector('meta[name="description"]');
    if (descTag) descTag.setAttribute('content', INDEX_DESCRIPTION);

    return () => {
      document.title = DEFAULT_PAGE_TITLE;
      if (descTag) descTag.setAttribute('content', 'Search any artist and find where to support them directly on alternative platforms like Bandcamp, Mirlo, and more.');
    };
  }, []);

  useEffect(() => {
    fetch('/data/guides/guides-manifest.json')
      .then(res => res.json())
      .then((data: GuideEntry[]) => {
        const sorted = data.sort((a, b) => b.published.localeCompare(a.published));
        setGuides(sorted);
      })
      .catch((e) => { Sentry.captureException(e, { extra: { context: 'guides.fetchManifest' } }); setGuides([]) })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen">

      <Header />
      <div className="pt-6 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-2">Guides</h1>
          <p className="text-text-secondary text-lg">
            How streaming payouts work, platforms worth knowing about, and ways to put more money in artists' pockets.
          </p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          {loading ? (
            <SkeletonScreen label="Loading guides">
              <ArticleListSkeleton />
            </SkeletonScreen>
          ) : guides.length === 0 ? (
            <p className="text-text-muted text-center">No guides yet. Check back soon.</p>
          ) : (
            <div className="space-y-4">
              {guides.map(guide => (
                <Link
                  key={guide.slug}
                  to={`/guides/${guide.slug}`}
                  className="block bg-surface-secondary rounded-xl p-6 border border-border hover:border-accent-primary/40 transition-colors"
                >
                  <div>
                    <h2 className="font-display text-lg font-semibold text-text-primary mb-1">
                      {guide.title}
                    </h2>
                    <p className="text-text-secondary text-sm">{guide.description}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
