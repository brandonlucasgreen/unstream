import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { useTheme } from '../hooks/useTheme';
import { Footer } from '../components/Footer';

interface GuideEntry {
  slug: string;
  title: string;
  description: string;
  pillar: string;
  published: string;
}

const PILLAR_LABELS: Record<string, string> = {
  'artist-economics': 'Artist economics',
  'platform-discovery': 'Platform discovery',
  'how-to': 'How-to for fans',
  'builder': 'Builder / open source',
};

export function GuidesIndexPage() {
  const { preference, cycleTheme } = useTheme();
  const [guides, setGuides] = useState<GuideEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/data/guides/guides-manifest.json')
      .then(res => res.json())
      .then((data: GuideEntry[]) => {
        const sorted = data.sort((a, b) => b.published.localeCompare(a.published));
        setGuides(sorted);
      })
      .catch(() => setGuides([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen">
      <ArtistAuthBar />
      <header className="pt-8 pb-8 px-4 relative">
        <div className="absolute top-4 right-4">
          <ThemeToggle preference={preference} onCycle={cycleTheme} />
        </div>
        <div className="max-w-4xl mx-auto text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors mb-4"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to search
          </Link>
          <h1 className="font-display text-3xl md:text-4xl font-semibold text-text-primary mb-2">Guides</h1>
          <p className="text-text-secondary text-lg">
            How streaming payouts work, platforms worth knowing about, and ways to put more money in artists' pockets.
          </p>
        </div>
      </header>

      <main className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          {loading ? (
            <p className="text-text-muted text-center">Loading...</p>
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
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-display text-lg font-semibold text-text-primary mb-1">
                        {guide.title}
                      </h2>
                      <p className="text-text-secondary text-sm">{guide.description}</p>
                    </div>
                    <span className="shrink-0 text-xs text-text-muted bg-surface-primary px-2 py-1 rounded">
                      {PILLAR_LABELS[guide.pillar] || guide.pillar}
                    </span>
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
