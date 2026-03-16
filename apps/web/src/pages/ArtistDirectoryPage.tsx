import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { Footer } from '../components/Footer';

interface DirectoryArtist {
  slug: string;
  name: string;
  imageUrl: string | null;
}

export function ArtistDirectoryPage() {
  const [artists, setArtists] = useState<DirectoryArtist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/artist-directory');
        if (res.ok) {
          const data = await res.json();
          setArtists(data.artists || []);
        }
      } catch { /* ignore */ }
      setLoading(false);
    }
    load();
  }, []);

  // Group by first letter
  const grouped: Record<string, DirectoryArtist[]> = {};
  for (const artist of artists) {
    const letter = (artist.name[0] || '#').toUpperCase();
    const key = /[A-Z]/.test(letter) ? letter : '#';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(artist);
  }
  const sortedLetters = Object.keys(grouped).sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <ArtistAuthBar />

      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="pt-12 pb-8 text-center px-6">
          <Link to="/" className="text-sm font-semibold text-text-muted uppercase tracking-wide hover:text-text-primary transition-colors">
            Unstream
          </Link>
          <h1 className="text-2xl font-bold mt-1 mb-2">Artist Directory</h1>
          {!loading && (
            <p className="text-text-muted text-sm">
              {artists.length} verified artist{artists.length !== 1 ? 's' : ''} on platforms that pay fairly
            </p>
          )}
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-text-muted">Loading...</span>
          </div>
        ) : (
          <>
            {/* Letter navigation */}
            <div className="max-w-3xl mx-auto w-full px-6 mb-8">
              <div className="flex flex-wrap gap-1.5 justify-center">
                {sortedLetters.map(letter => (
                  <a
                    key={letter}
                    href={`#letter-${letter}`}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-bg-secondary border border-border text-sm font-semibold hover:border-accent-primary transition-colors"
                  >
                    {letter}
                  </a>
                ))}
              </div>
            </div>

            {/* Artist groups */}
            <div className="max-w-3xl mx-auto w-full px-6 pb-12">
              <div className="space-y-8">
                {sortedLetters.map(letter => (
                  <div key={letter} id={`letter-${letter}`} className="scroll-mt-20">
                    <h2 className="text-xl font-bold pb-2 border-b border-border mb-1">{letter}</h2>
                    <div className="grid gap-0.5">
                      {grouped[letter].map(artist => (
                        <a
                          key={artist.slug}
                          href={`/a/${artist.slug}`}
                          className="flex items-center gap-3 px-3.5 py-2.5 rounded-lg hover:bg-bg-secondary border border-transparent hover:border-border transition-colors"
                        >
                          {artist.imageUrl ? (
                            <img
                              src={artist.imageUrl}
                              alt=""
                              className="w-9 h-9 rounded-full object-cover bg-bg-secondary flex-shrink-0"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-full bg-bg-secondary flex-shrink-0 flex items-center justify-center font-semibold text-sm text-text-muted">
                              {artist.name[0]?.toUpperCase() || '?'}
                            </div>
                          )}
                          <span className="text-sm font-medium">{artist.name}</span>
                          <svg className="ml-auto flex-shrink-0 w-3.5 h-3.5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}
