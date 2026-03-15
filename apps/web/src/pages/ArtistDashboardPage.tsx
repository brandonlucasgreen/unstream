import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getSession, waitForMagicLinkSession } from '../services/auth';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { Footer } from '../components/Footer';

interface ClaimedProfile {
  id: string;
  artistId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  websiteUrl?: string;
  bio?: string;
  claimedAt: string;
}

export function ArtistDashboardPage() {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<ClaimedProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDashboard() {
      let session;

      // Handle magic link callback hash
      if (window.location.hash.includes('access_token')) {
        const { session: magicSession, error: authError } = await waitForMagicLinkSession();
        if (authError || !magicSession) {
          // Redirect to login with the error visible there
          navigate('/artist-login', { replace: true });
          return;
        }
        window.history.replaceState(null, '', window.location.pathname);
        session = magicSession;
      } else {
        session = await getSession();
      }

      if (!session) {
        navigate('/artist-login', { replace: true });
        return;
      }

      try {
        const response = await fetch('/api/artist-auth', {
          headers: { 'Authorization': `Bearer ${session.access_token}` },
        });

        if (!response.ok) {
          if (response.status === 401) {
            navigate('/artist-login', { replace: true });
            return;
          }
          throw new Error('Failed to load profiles');
        }

        const data = await response.json();
        setProfiles(data.profiles || []);
      } catch {
        setError('Failed to load your profiles. Please try again.');
      }
      setLoading(false);
    }
    loadDashboard();
  }, [navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted">Loading your profiles...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <ArtistAuthBar />

      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Your Artist Profiles</h1>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {profiles.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <p className="text-text-muted">No claimed profiles yet.</p>
              <Link
                to="/"
                className="inline-block px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
              >
                Search for your artist page
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {profiles.map(profile => (
                <div
                  key={profile.id}
                  className="flex items-center gap-4 p-4 rounded-lg bg-bg-secondary border border-border"
                >
                  {profile.imageUrl ? (
                    <img
                      src={profile.imageUrl}
                      alt={profile.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-bg-hover flex items-center justify-center text-text-muted text-lg">
                      {profile.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{profile.name}</p>
                    <p className="text-sm text-text-muted">
                      unstream.stream/a/{profile.slug}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Link
                      to={`/artist-edit/${profile.slug}`}
                      className="px-3 py-1.5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
                    >
                      Edit
                    </Link>
                    <Link
                      to={`/a/${profile.slug}`}
                      className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors"
                    >
                      View
                    </Link>
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
