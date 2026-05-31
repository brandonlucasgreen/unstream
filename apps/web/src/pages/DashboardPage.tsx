import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { ArtistAnalytics } from '../components/ArtistAnalytics';
import { Footer } from '../components/Footer';
import { SearchBar } from '../components/SearchBar';

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

interface SavedArtist {
  artistId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  notes?: string;
  addedAt: string;
  claimed?: boolean;
  supported: boolean;
  supportedAt?: string;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [claimedProfiles, setClaimedProfiles] = useState<ClaimedProfile[]>([]);
  const [savedArtists, setSavedArtists] = useState<SavedArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [undoToast, setUndoToast] = useState<{ message: string; artistId: string; onUndo: () => void } | null>(null);
  const [supportingSlug, setSupportingSlug] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

  useEffect(() => {
    if (authLoading) return;

    if (!session) {
      navigate('/login', { replace: true });
      return;
    }

    async function loadData() {
      try {
        const [claimedResponse, savedResponse] = await Promise.all([
          fetch('/api/artist-auth', {
            headers: { 'Authorization': `Bearer ${session!.access_token}` },
          }),
          fetch('/api/saved-artists', {
            headers: { 'Authorization': `Bearer ${session!.access_token}` },
          }),
        ]);

        if (!claimedResponse.ok) {
          if (claimedResponse.status === 401) {
            navigate('/login', { replace: true });
            return;
          }
          throw new Error('Failed to load claimed profiles');
        }

        if (!savedResponse.ok) {
          throw new Error('Failed to load saved artists');
        }

        const claimedData = await claimedResponse.json();
        setClaimedProfiles(claimedData.profiles || []);

        const savedData = await savedResponse.json();
        setSavedArtists(savedData.savedArtists || []);
      } catch {
        setError('Failed to load your profiles. Please try again.');
      }
      setLoading(false);
    }
    loadData();
  }, [session, authLoading, navigate]);

  // Show toast auto-dismiss
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // Show undo toast auto-dismiss
  useEffect(() => {
    if (undoToast) {
      const timer = setTimeout(() => setUndoToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [undoToast]);

  const handleRemoveSavedArtist = async (artistId: string) => {
    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session!.access_token}`,
        },
        body: JSON.stringify({ action: 'remove', artistId }),
      });

      if (!response.ok) {
        throw new Error('Failed to remove saved artist');
      }

      // Optimistically remove from list
      setSavedArtists(prev => {
        const next = prev.filter(a => a.artistId !== artistId);
        // If current page is now empty, go to previous page
        const totalPages = Math.ceil(next.length / PAGE_SIZE);
        if (currentPage > totalPages && totalPages > 0) {
          setCurrentPage(totalPages);
        }
        return next;
      });

      // Adjust page if the current page would be empty after removal
      // Use a microtask to ensure state has updated before checking
      const remaining = savedArtists.filter(a => a.artistId !== artistId);
      const totalPagesAfter = Math.ceil(remaining.length / PAGE_SIZE);
      if (currentPage > totalPagesAfter && totalPagesAfter > 0) {
        setCurrentPage(totalPagesAfter);
      } else if (remaining.length === 0) {
        setCurrentPage(1);
      }

      // Show undo toast
      setUndoToast({
        message: 'Removed from saved',
        artistId,
        onUndo: () => handleUndoRemove(artistId),
      });
    } catch {
      setError('Failed to remove artist. Please try again.');
    }
  };

  const handleUndoRemove = async (artistId: string) => {
    setUndoToast(null);

    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session!.access_token}`,
        },
        body: JSON.stringify({ artistId, notes: null }),
      });

      if (!response.ok) {
        throw new Error('Failed to restore artist');
      }

      const data = await response.json();
      setSavedArtists(prev => [...prev, data.savedArtist]);
      setToast({ message: 'Artist restored!', type: 'success' });
    } catch {
      setError('Failed to restore artist. Please try again.');
    }
  };

  const handleRemoveClaimedProfile = async (_profileId: string, _artistId: string, _slug: string) => {
    // For now, just show a message - actual removal would require additional API
    setToast({ message: 'Profile management coming soon!', type: 'info' });
  };

  const handleToggleSupport = async (artist: SavedArtist) => {
    const newSupported = !artist.supported;
    const slug = artist.artistId;
    const originalSupported = artist.supported;
    const originalSupportedAt = artist.supportedAt;

    setSavedArtists(prev => prev.map(a =>
      a.artistId === slug ? { ...a, supported: newSupported, supportedAt: newSupported ? new Date().toISOString() : undefined } : a
    ));

    setSupportingSlug(slug);
    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session!.access_token}`,
        },
        body: JSON.stringify({ action: newSupported ? 'support' : 'unsupport', artistId: slug }),
      });

      if (!response.ok) {
        throw new Error('Failed to update support status');
      }

      const data = await response.json();
      setSavedArtists(prev => prev.map(a =>
        a.artistId === slug ? { ...a, supported: data.savedArtist.supported, supportedAt: data.savedArtist.supportedAt } : a
      ));
    } catch {
      setSavedArtists(prev => prev.map(a =>
        a.artistId === slug ? { ...a, supported: originalSupported, supportedAt: originalSupportedAt } : a
      ));
      setToast({ message: 'Failed to update support status. Please try again.', type: 'error' });
    } finally {
      setSupportingSlug(null);
    }
  };

  const handleDashboardSearch = (query: string) => {
    navigate(`/?q=${encodeURIComponent(query)}`);
  };

  // Pagination helpers
  const totalPages = Math.ceil(savedArtists.length / PAGE_SIZE);
  const clampedPage = Math.min(currentPage, Math.max(1, totalPages));
  const paginatedArtists = savedArtists.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const goToPage = useCallback((page: number) => {
    const clamped = Math.min(Math.max(1, page), totalPages);
    if (clamped !== clampedPage) setCurrentPage(clamped);
  }, [totalPages, clampedPage]);

  // Redirect to login if not authenticated
  if (!authLoading && !session) {
    return <Navigate to="/login" replace />;
  }

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-6xl mx-auto space-y-8">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
          </div>

          {error && (
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Your Artists Section - Only if user has claimed profiles */}
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
                          <button
                            onClick={() => handleRemoveClaimedProfile(profile.id, profile.artistId, profile.slug)}
                            className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-red-400 hover:border-red-500/30 transition-colors"
                            title="Remove profile (coming soon)"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                    <ArtistAnalytics slug={profile.slug} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Saved Artists Section */}
          <section>
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-accent-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              Saved Artists
            </h2>
            <div className="mb-4">
              <SearchBar onSearch={handleDashboardSearch} isLoading={false} />
            </div>

            {savedArtists.length === 0 ? (
              <div className="text-center py-12 rounded-lg border border-border border-dashed">
                <p className="text-text-muted">No saved artists yet.</p>
                <p className="text-text-muted text-sm mt-1">
                  Save artists you want to support for later.
                </p>
                <Link
                  to="/"
                  className="inline-block mt-4 px-4 py-2 rounded-lg bg-accent-secondary text-white text-sm font-medium hover:bg-accent-secondary/90 transition-colors"
                >
                  Search for artists
                </Link>
              </div>
            ) : (
              <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {paginatedArtists.map(artist => (
                  <div
                    key={artist.artistId}
                    className="p-4 rounded-lg bg-bg-secondary border border-border hover:border-border-hover transition-colors"
                  >
                    <div className="flex gap-4">
                      <div className="flex-shrink-0">
                        <div className="w-16 h-16 rounded-full bg-bg-hover flex items-center justify-center text-text-muted text-xl flex-shrink-0 overflow-hidden">
                          {artist.imageUrl ? (
                            <img
                              src={artist.imageUrl}
                              alt={artist.name}
                              className="w-full h-full object-cover rounded-full"
                              onError={(e) => { const el = e.target as HTMLImageElement; el.style.display = 'none'; el.parentElement!.querySelector('.fallback')?.classList.remove('hidden'); }}
                            />
                          ) : null}
                          <span className={artist.imageUrl ? 'hidden fallback' : ''}>
                            {artist.name.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{artist.name}</p>
                        {artist.claimed && artist.slug ? (
                          <p className="text-sm text-text-muted truncate">
                            unstream.stream/a/{artist.slug}
                          </p>
                        ) : (
                          <p className="text-sm text-text-muted">Saved from search</p>
                        )}
                        {artist.notes && (
                          <p className="text-xs text-text-muted mt-2 line-clamp-2">
                            {artist.notes}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-3 flex-wrap">
                          {artist.claimed && artist.slug ? (
                            <Link
                              to={`/a/${artist.slug}`}
                              className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors"
                            >
                              View
                            </Link>
                          ) : (
                            <Link
                              to={`/?q=${encodeURIComponent(artist.name)}`}
                              className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors"
                            >
                              Search
                            </Link>
                          )}
                          <button
                            onClick={() => handleToggleSupport(artist)}
                            disabled={supportingSlug === artist.artistId}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                              artist.supported
                                ? 'bg-accent-secondary/15 border border-accent-secondary/40 text-accent-secondary hover:bg-accent-secondary/25'
                                : 'border border-border text-text-muted hover:text-text-primary hover:border-border-hover'
                            } ${supportingSlug === artist.artistId ? 'opacity-50 cursor-not-allowed' : ''}`}
                          >
                            {artist.supported ? (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="10" strokeWidth={2} />
                              </svg>
                            )}
                            {artist.supported ? 'Supported ✓' : 'Mark supported'}
                          </button>
                            <button
                            onClick={() => handleRemoveSavedArtist(artist.artistId)}
                            className="p-1.5 rounded-lg border border-border text-text-muted hover:text-red-400 hover:border-red-500/30 transition-colors"
                            title="Remove"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.862 21H9.138a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <button
                    onClick={() => goToPage(clampedPage - 1)}
                    disabled={clampedPage === 1}
                    className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-text-muted px-2">
                    {clampedPage} / {totalPages}
                  </span>
                  <button
                    onClick={() => goToPage(clampedPage + 1)}
                    disabled={clampedPage === totalPages}
                    className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              )}
              </>
            )}
          </section>
        </div>
      </main>

      {/* Toast Notifications */}
      <div className="fixed bottom-6 right-6 z-50 space-y-2 pointer-events-none">
        {toast && (
          <div className={`pointer-events-auto px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-in slide-in-from-right duration-300 ${
            toast.type === 'error' ? 'bg-red-500/10 border border-red-500/20 text-red-400' :
            toast.type === 'info' ? 'bg-accent-primary/10 border border-accent-primary/20 text-accent-primary' :
            'bg-green-500/10 border border-green-500/20 text-green-400'
          }`}>
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {toast.type === 'error' ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              ) : toast.type === 'info' ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              )}
            </svg>
            <span className="text-sm font-medium">{toast.message}</span>
          </div>
        )}

        {undoToast && (
          <div className="pointer-events-auto px-4 py-3 rounded-lg bg-accent-primary/10 border border-accent-primary/20 text-accent-primary shadow-lg animate-in slide-in-from-right duration-300 flex items-center gap-3">
            <span className="text-sm font-medium">{undoToast.message}</span>
            <button
              onClick={undoToast.onUndo}
              className="px-3 py-1 rounded-md bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
            >
              Undo
            </button>
          </div>
        )}
      </div>

      <Footer />
    </div>
  );
}
