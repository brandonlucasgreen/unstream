import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { Skeleton, SkeletonScreen } from '../components/Skeleton';
import { ArticleListSkeleton } from '../components/LoadingSkeletons';
import { DEFAULT_PAGE_TITLE } from '../data/seo';

interface ChangelogEntry {
  id: string;
  title: string;
  description: string;
  date: string;
  announced: boolean;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function ChangelogPage() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = 'Changelog - Unstream';
    const descTag = document.querySelector('meta[name="description"]');
    if (descTag) descTag.setAttribute('content', 'What\'s new in Unstream — a running log of shipped features and improvements.');

    fetch('/data/shipped-features.json')
      .then(res => res.json())
      .then((data: ChangelogEntry[]) => {
        const sorted = [...data].sort((a, b) => b.date.localeCompare(a.date));
        setEntries(sorted);
      })
      .catch((e) => { Sentry.captureException(e, { extra: { context: 'changelog.fetchEntries' } }); setEntries([]) })
      .finally(() => setLoading(false));

    return () => {
      document.title = DEFAULT_PAGE_TITLE;
      const descTag = document.querySelector('meta[name="description"]');
      if (descTag) descTag.setAttribute('content', 'Search any artist and find where to support them directly on alternative platforms like Bandcamp, Mirlo, and more.');
    };
  }, []);

  // Group entries by date
  const grouped = entries.reduce<Record<string, ChangelogEntry[]>>((acc, entry) => {
    if (!acc[entry.date]) acc[entry.date] = [];
    acc[entry.date].push(entry);
    return acc;
  }, {});

  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  return (
    <div className="min-h-screen">
      <Header />

      <div className="pt-6 pb-8 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-2">Changelog</h1>
          <p className="text-text-secondary text-lg">
            What's new in Unstream.
          </p>
        </div>
      </div>

      <main className="px-4 pb-16">
        <div className="max-w-2xl mx-auto">
          {loading ? (
            <SkeletonScreen label="Loading the changelog">
              <Skeleton className="h-3 w-28 mb-4" />
              <ArticleListSkeleton count={3} />
            </SkeletonScreen>
          ) : entries.length === 0 ? (
            <p className="text-text-muted text-center">Nothing here yet.</p>
          ) : (
            <div className="space-y-10">
              {dates.map(date => (
                <div key={date}>
                  <p className="text-text-muted text-sm font-medium mb-4">{formatDate(date)}</p>
                  <div className="space-y-4">
                    {grouped[date].map(entry => (
                      <div
                        key={entry.id}
                        className="bg-surface-secondary rounded-xl p-5 border border-border"
                      >
                        <h2 className="font-display text-base font-semibold text-text-primary mb-1">
                          {entry.title}
                        </h2>
                        <p className="text-text-secondary text-sm">{entry.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
