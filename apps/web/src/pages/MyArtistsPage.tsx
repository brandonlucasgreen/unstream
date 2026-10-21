import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { ClaimedArtistsSection } from '../components/ClaimedArtistsSection';

/**
 * Artist management: the profiles this account has claimed, each with its stats and the
 * way into its settings.
 *
 * Split out of the old /dashboard, which put this above a fan's releases, collection and
 * saved artists — two audiences and two jobs on one page. The sections each loaded
 * independently, so splitting the page costs nothing in requests: this page makes the one
 * call the artist half always made.
 */
export function MyArtistsPage() {
  const { session, isLoading: authLoading } = useAuth();

  if (!authLoading && !session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-6xl mx-auto space-y-8">
          <h1 className="text-2xl font-bold">My Artists</h1>

          <ClaimedArtistsSection />
        </div>
      </main>

      <Footer />
    </div>
  );
}
