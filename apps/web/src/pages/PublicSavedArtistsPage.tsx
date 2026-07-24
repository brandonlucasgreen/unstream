import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { PageSkeleton } from '../components/PageSkeleton';
import { ArtistRowsSkeleton } from '../components/LoadingSkeletons';
import { Skeleton } from '../components/Skeleton';

interface SavedArtistPublic {
  slug: string;
  name: string;
  image_url: string | null;
  supported: boolean;
}

interface PublicSharingData {
  owner_display_name: string;
  owner_location: string | null;
  saved_artists: SavedArtistPublic[];
}

export function PublicSavedArtistsPage() {
  const { handle } = useParams<{ handle: string }>();
  const [data, setData] = useState<PublicSharingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!handle) return;
    fetch(`/api/public/saved-artists/${encodeURIComponent(handle)}`)
      .then(res => {
        if (res.status === 404) {
          setNotFound(true);
          return null;
        }
        if (!res.ok) throw new Error('Failed to load');
        return res.json();
      })
      .then(d => {
        if (d) setData(d);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [handle]);

  const handleCopy = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = url;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading) {
    return (
      <PageSkeleton label="Loading saved artists">
        <div className="flex flex-col items-center mb-8">
          <Skeleton className="h-7 w-64 mb-3" />
          <Skeleton className="h-9 w-36 rounded-lg" />
        </div>
        <ArtistRowsSkeleton count={6} />
      </PageSkeleton>
    );
  }

  if (notFound || !data) {
    return (
      <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
        <Header />
        <main className="flex-1 p-6">
          <div className="max-w-2xl mx-auto text-center py-16">
            <h1 className="text-2xl font-bold mb-4">Not found</h1>
            <p className="text-text-muted mb-6">
              This saved artists list is either private or doesn't exist.
            </p>
            <Link
              to="/"
              className="inline-block px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
            >
              Back to Unstream
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />
      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold">{data.owner_display_name}'s saved artists</h1>
            {data.owner_location && (
              <p className="text-text-primary text-sm mt-2">{data.owner_location}</p>
            )}
            <button
              onClick={handleCopy}
              className={`mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                copied
                  ? 'border-green-500/30 text-green-400'
                  : 'border-border text-text-muted hover:text-text-primary hover:border-border-hover'
              }`}
            >
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              {copied ? 'Copied!' : 'Copy URL'}
            </button>
          </div>

          {data.saved_artists.length === 0 ? (
            <div className="text-center py-12 rounded-lg border border-border border-dashed">
              <p className="text-text-muted">No saved artists yet.</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {data.saved_artists.map(artist => (
                <Link
                  key={artist.slug || artist.name}
                  to={artist.slug ? `/a/${artist.slug}` : `/?q=${encodeURIComponent(artist.name)}`}
                  className="flex items-center gap-4 p-4 rounded-lg bg-bg-secondary border border-border hover:border-border-hover transition-colors"
                >
                  <div className="w-14 h-14 rounded-full bg-bg-hover flex items-center justify-center text-text-muted text-xl flex-shrink-0 overflow-hidden">
                    {artist.image_url ? (
                      <img
                        src={artist.image_url}
                        alt={artist.name}
                        className="w-full h-full object-cover rounded-full"
                        onError={(e) => { const el = e.target as HTMLImageElement; el.style.display = 'none'; el.parentElement?.querySelector('.fallback')?.classList.remove('hidden'); }}
                      />
                    ) : null}
                    <span className={artist.image_url ? 'hidden fallback' : ''}>
                      {artist.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{artist.name}</p>
                    {artist.supported && (
                      <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-xs font-medium bg-accent-secondary/15 text-accent-secondary">
                        <svg width="10" height="10" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                        Supported
                      </span>
                    )}
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