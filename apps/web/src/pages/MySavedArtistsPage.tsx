import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { SavedArtistsSection } from '../components/SavedArtistsSection';
import { ReleaseCalendarSection } from '../components/ReleaseCalendarSection';

/**
 * The artists a fan follows: the saved list (and which of them they've supported), and the one
 * release calendar that covers all of them. Split out of /my-collection on 2026-11-08, which kept
 * what the fan *has* — the releases out now and the records they've bought.
 *
 * The saved list comes from AuthContext, which `SavedArtistsSection` asks to load; this page
 * fetches nothing of its own.
 */
export function MySavedArtistsPage() {
  const { session, isLoading: authLoading, savedArtists, artistsLoaded } = useAuth();

  if (!authLoading && !session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-6xl mx-auto space-y-8">
          <h1 className="text-2xl font-bold">My Saved Artists</h1>

          <SavedArtistsSection />

          {/*
            Gated on the fan having saved somebody — asked and answered (Brandon, 2026-10-21):
            their feed would carry nothing, and the subscription only means something once there
            is an artist to follow. Don't ungate it, and don't add a second subscribe entry point
            elsewhere to make it reachable sooner. `artistsLoaded` keeps it from flashing in and out
            while the list arrives.
          */}
          {artistsLoaded && savedArtists.length > 0 && <ReleaseCalendarSection />}
        </div>
      </main>

      <Footer />
    </div>
  );
}
