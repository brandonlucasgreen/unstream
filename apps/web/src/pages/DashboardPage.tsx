import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';

import { AccountLayout } from '../components/AccountLayout';
import { ArtistAnalytics } from '../components/ArtistAnalytics';
import { SkeletonScreen } from '../components/Skeleton';
import { DashboardSkeleton } from '../components/LoadingSkeletons';
import { RecentReleasesSection, type RecentRelease } from '../components/RecentReleasesSection';
import { ReleaseFeedControls } from '../components/ReleaseFeedControls';

/**
 * The signed-in home: what changed since last time, and how the artists you own are doing.
 *
 * Saved artists and the collection are their own pages now. This one deliberately fetches one
 * thing of its own — the release shortlists — and reads everything else from AuthContext, which
 * loads each list once per session. The old version fetched claimed profiles, saved artists,
 * releases and the whole collection before it rendered a single pixel.
 */
export function DashboardPage() {
  const { session, savedArtists, artistsLoaded, loadSavedArtists, claimedProfiles } = useAuth();
  const [upcomingReleases, setUpcomingReleases] = useState<RecentRelease[]>([]);
  const [recentReleases, setRecentReleases] = useState<RecentRelease[]>([]);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [releasesLoading, setReleasesLoading] = useState(true);

  // Only to decide which empty state is honest below — the releases render without it.
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    loadSavedArtists(controller.signal);
    return () => controller.abort();
  }, [session, loadSavedArtists]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();

    fetch('/api/me/recent-releases', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
      signal: controller.signal,
    })
      .then(response => {
        if (!response.ok) throw new Error(`recent-releases failed: ${response.status}`);
        return response.json();
      })
      .then(data => {
        setUpcomingReleases(data.upcoming || []);
        setRecentReleases(data.recent || []);
      })
      .catch(e => {
        if (controller.signal.aborted) return;
        Sentry.captureException(e, { extra: { context: 'dashboard.loadRecentReleases' } });
        setReleasesError("Couldn't load recent releases. Try refreshing.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setReleasesLoading(false);
      });

    return () => controller.abort();
  }, [session]);

  const hasReleases = upcomingReleases.length > 0 || recentReleases.length > 0;
  // RecentReleasesSection's own empty state says "nothing new from your saved artists", which
  // is only true once there are some. Somebody who has saved nobody gets told that instead.
  const showFirstSavePrompt = !hasReleases && artistsLoaded && savedArtists.length === 0;

  return (
    <AccountLayout title="Dashboard">
      <div className="space-y-8">
        {claimedProfiles.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM21 16c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
              </svg>
              Your Artists
            </h2>
            <div className="space-y-3">
              {claimedProfiles.map(profile => (
                <div
                  key={profile.id}
                  className="p-4 rounded-lg bg-bg-secondary border border-border"
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
                      {/* The sidebar carries these too, but only once you're already on the
                          artist — from here they're the way in. */}
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
        )}

        {releasesLoading ? (
          <SkeletonScreen label="Loading your releases">
            <DashboardSkeleton />
          </SkeletonScreen>
        ) : showFirstSavePrompt ? (
          <section>
            <h2 className="text-lg font-semibold mb-4">Upcoming Releases</h2>
            <div className="text-center py-12 rounded-lg border border-border border-dashed">
              <p className="text-text-muted">Save an artist and their next release shows up here.</p>
              <Link
                to="/"
                className="inline-block mt-4 px-4 py-2 rounded-lg bg-accent-secondary text-white text-sm font-medium hover:bg-accent-secondary/90 transition-colors"
              >
                Search for artists
              </Link>
            </div>
          </section>
        ) : (
          <RecentReleasesSection
            upcoming={upcomingReleases}
            recent={recentReleases}
            error={releasesError}
            subscribePanel={<ReleaseFeedControls />}
          />
        )}
      </div>
    </AccountLayout>
  );
}
