import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { ArtistAnalytics } from './ArtistAnalytics';
import { ArtistRowsSkeleton } from './LoadingSkeletons';

// The body of /my-artists: the profiles this user has claimed, with their stats.
//
// It carries no heading of its own — the page is dedicated to it, so the h1 there is the
// only one needed. It fetches and skeletons on its own rather than being handed data by
// the page.

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
        Sentry.captureException(e, { extra: { context: 'myArtists.loadClaimedProfiles' } });
        setError("Couldn't load your artist profiles. Try refreshing.");
        setProfiles([]);
      });

    return () => controller.abort();
  }, [session, navigate]);

  return (
    <section>
      {error && <p className="text-sm text-error mb-3">{error}</p>}

      {profiles === null ? (
        !error && <ArtistRowsSkeleton count={2} />
      ) : profiles.length === 0 ? (
        /*
          Most people have claimed nothing, so this is the state this page is usually in.
          It points at search because claiming starts from a search result — there is no
          way to reach /claim/:slug without first finding the artist.
        */
        !error && (
          <div className="text-center py-12 rounded-lg border border-border border-dashed">
            <p className="text-text-muted">You haven't claimed an artist profile yet.</p>
            <p className="text-text-muted text-sm mt-1">
              If you're an artist,{' '}
              <Link to="/" className="text-link hover:underline">
                search for your name
              </Link>{' '}
              and claim your profile to edit your links, bio and releases.
            </p>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {profiles.map(profile => (
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
                      className="px-3 py-1.5 rounded-lg bg-accent-primary text-accent-foreground text-sm font-medium hover:bg-accent-primary/90 transition-colors"
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
              </div>
              <ArtistAnalytics slug={profile.slug} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
