import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { ArtistAnalytics } from './ArtistAnalytics';

// The artist half of the dashboard: the profiles this user has claimed, with their stats.
//
// It fetches and skeletons on its own rather than being handed data by the page. Nothing
// below it on the dashboard depends on the answer, so making the whole page wait for this
// one — which is what a single page-level `loading` flag did — delayed the collection read
// by a full round trip for no reason.

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

export function ClaimedArtistsSection() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<ClaimedProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();

    fetch('/api/artist-auth', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
      signal: controller.signal,
    })
      .then(response => {
        // A rejected token here means the session is gone, not that this section failed.
        if (response.status === 401) {
          navigate('/login', { replace: true });
          return null;
        }
        if (!response.ok) throw new Error(`artist-auth failed: ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (data) setProfiles(data.profiles || []);
      })
      .catch(e => {
        if (controller.signal.aborted) return;
        Sentry.captureException(e, { extra: { context: 'dashboard.loadClaimedProfiles' } });
        setError("Couldn't load your artist profiles. Try refreshing.");
        setProfiles([]);
      });

    return () => controller.abort();
  }, [session, navigate]);

  // Most people have claimed nothing, so this section stays entirely absent for them —
  // including while it loads. A skeleton that resolves to nothing is worse than no skeleton.
  if (!error && (profiles === null || profiles.length === 0)) {
    return null;
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <svg className="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM21 16c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
        </svg>
        Your Artists
      </h2>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      <div className="space-y-3">
        {(profiles || []).map(profile => (
          <div
            key={profile.id}
            className="p-4 rounded-lg bg-bg-secondary border border-border hover:border-border-hover transition-colors"
          >
            <div className="flex gap-4">
              <div className="flex-shrink-0">
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
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">{profile.name}</p>
                <p className="text-sm text-text-muted truncate">
                  unstream.stream/a/{profile.slug}
                </p>
                <div className="flex items-center gap-2 mt-3">
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
                  {/* Reachable from the profile editor too, but releases are the thing an
                      artist comes back to correct — worth one click from here. */}
                  <Link
                    to={`/artist-edit/${profile.slug}/releases`}
                    className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors"
                  >
                    Releases
                  </Link>
                </div>
              </div>
            </div>
            <ArtistAnalytics slug={profile.slug} />
          </div>
        ))}
      </div>
    </section>
  );
}
