import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { ClaimedArtistsSection } from '../components/ClaimedArtistsSection';
import { SavedArtistsSection } from '../components/SavedArtistsSection';
import { CollectionSection } from '../components/CollectionSection';
import { RecentReleasesSection, type RecentRelease } from '../components/RecentReleasesSection';
import { ReleaseFeedControls } from '../components/ReleaseFeedControls';

/**
 * The signed-in home, as a composition of sections that each load on their own.
 *
 * It used to hold one `loading` flag covering three fetches, and render nothing until the
 * slowest of them settled. Because `CollectionSection` only mounted after that, the
 * collection read — the heaviest one on the page — didn't *start* until the other three had
 * finished. Four requests in two serial waves, with no data dependency justifying the
 * second. Now every section fetches as soon as the page mounts and shows its own skeleton,
 * so the wall-clock cost is the slowest single request rather than the sum of two rounds.
 */
export function DashboardPage() {
  const { session, isLoading: authLoading, savedArtists, artistsLoaded } = useAuth();
  const [upcomingReleases, setUpcomingReleases] = useState<RecentRelease[]>([]);
  const [recentReleases, setRecentReleases] = useState<RecentRelease[]>([]);
  const [releasesError, setReleasesError] = useState<string | null>(null);

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
      });

    return () => controller.abort();
  }, [session]);

  if (!authLoading && !session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-6xl mx-auto space-y-8">
          <h1 className="text-2xl font-bold">Dashboard</h1>

          <ClaimedArtistsSection />

          {/*
            Upcoming and Recent Releases — above Saved Artists because they are the part of
            this page that changes, and only rendered once the fan has saved somebody: an
            empty releases box for a fan with no saved artists would be a second empty state
            saying the same thing as the one below it. `artistsLoaded` gates it so the box
            doesn't flash in and out while the list is still arriving.
          */}
          {artistsLoaded && savedArtists.length > 0 && (
            <RecentReleasesSection
              upcoming={upcomingReleases}
              recent={recentReleases}
              error={releasesError}
              subscribePanel={<ReleaseFeedControls />}
            />
          )}

          {/*
            The collection — releases actually bought (Support Loop Step 3). Its empty state
            points at the Bandcamp import, a different action from the saved-artists empty
            state below, so the two never say the same thing twice.
          */}
          <CollectionSection />

          <SavedArtistsSection />
        </div>
      </main>

      <Footer />
    </div>
  );
}
