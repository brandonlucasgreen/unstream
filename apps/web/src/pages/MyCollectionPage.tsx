import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { SavedArtistsSection } from '../components/SavedArtistsSection';
import { CollectionSection } from '../components/CollectionSection';
import { RecentReleasesSection, type RecentRelease } from '../components/RecentReleasesSection';
import { ReleaseFeedControls } from '../components/ReleaseFeedControls';
import { WelcomeBanner } from '../components/WelcomeBanner';
import { YourTips } from '../components/YourTips';

/**
 * The fan's home: releases from the artists they follow, the records they've bought, and
 * the artists they've saved. The artist half of the old /dashboard now lives at
 * /my-artists.
 *
 * It is a composition of sections that each load on their own. The page used to hold one
 * `loading` flag covering three fetches and render nothing until the slowest settled.
 * Because `CollectionSection` only mounted after that, the collection read — the heaviest
 * one on the page — didn't *start* until the others had finished: two serial waves with no
 * data dependency justifying the second. Now every section fetches as soon as the page
 * mounts and shows its own skeleton, so the wall-clock cost is the slowest single request.
 */
export function MyCollectionPage() {
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
        Sentry.captureException(e, { extra: { context: 'myCollection.loadRecentReleases' } });
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
          <h1 className="text-2xl font-bold">My Collection</h1>

          <WelcomeBanner />

          {/*
            Releases — Upcoming, Recent and the calendar — above the collection because they are
            the part of this page that changes, and only rendered once the fan has saved
            somebody: an empty releases box for a fan with no saved artists would be a second
            empty state saying the same thing as the one below it. `artistsLoaded` gates it so
            the box doesn't flash in and out while the list is still arriving.

            That gate also hides the Release calendar from a fan who has saved nobody — asked
            and answered (Brandon, 2026-10-21): leave it gated. Their feed would carry nothing,
            and the subscription only means something once there is an artist to follow. So
            don't "fix" the calendar's reachability by ungating this section or by moving the
            subscribe control back to /settings, where in months of being live not one fan ever
            minted a token.
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

          {/* Tips this fan has left. Renders nothing until there's one to show. */}
          <YourTips />
        </div>
      </main>

      <Footer />
    </div>
  );
}
