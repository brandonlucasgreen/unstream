import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { CollectionSection } from '../components/CollectionSection';
import { RecentReleasesSection, type RecentRelease } from '../components/RecentReleasesSection';
import { WelcomeBanner } from '../components/WelcomeBanner';
import { SecurityNudgeBanner } from '../components/SecurityNudgeBanner';

/**
 * The fan's home: releases from the artists they follow and the records they've bought. The
 * artist half of the old /dashboard lives at /my-artists; the saved-artists list and the release
 * calendar moved to /my-saved-artists, and Tip History to /settings (Brandon, 2026-11-08).
 *
 * It is a composition of sections that each load on their own. The page used to hold one
 * `loading` flag covering three fetches and render nothing until the slowest settled.
 * Because `CollectionSection` only mounted after that, the collection read — the heaviest
 * one on the page — didn't *start* until the others had finished: two serial waves with no
 * data dependency justifying the second. Now every section fetches as soon as the page
 * mounts and shows its own skeleton, so the wall-clock cost is the slowest single request.
 */
export function MyCollectionPage() {
  const { session, isLoading: authLoading, savedArtists, artistsLoaded, loadSavedArtists } = useAuth();
  const [upcomingReleases, setUpcomingReleases] = useState<RecentRelease[]>([]);
  const [recentReleases, setRecentReleases] = useState<RecentRelease[]>([]);
  const [releasesError, setReleasesError] = useState<string | null>(null);

  // The Releases gate below needs the saved list, which used to be loaded by the
  // SavedArtistsSection on this page. It now lives on /my-saved-artists, so ask for it here.
  // The context loads it once per session — a no-op if anything else got there first.
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

          {/* The one-time two-step-verification nudge; hidden by its own logic
              once dismissed or enrolled. */}
          <SecurityNudgeBanner />

          {/*
            Releases — Upcoming and Recent — above the collection because they are the part of
            this page that changes, and only rendered once the fan has saved somebody: for a fan
            following nobody it could only ever be empty. `artistsLoaded` gates it so the box
            doesn't flash in and out while the list is still arriving.
          */}
          {artistsLoaded && savedArtists.length > 0 && (
            <RecentReleasesSection
              upcoming={upcomingReleases}
              recent={recentReleases}
              error={releasesError}
            />
          )}

          {/*
            The collection — releases actually bought (Support Loop Step 3). Its empty state
            points at the Bandcamp import.
          */}
          <CollectionSection />
        </div>
      </main>

      <Footer />
    </div>
  );
}
