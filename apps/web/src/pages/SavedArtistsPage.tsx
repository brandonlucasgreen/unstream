import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { AccountLayout } from '../components/AccountLayout';
import { SkeletonScreen } from '../components/Skeleton';
import { ArtistRowsSkeleton } from '../components/LoadingSkeletons';
import type { SavedArtist } from '../contexts/AuthContext';

const PAGE_SIZE = 12;

/**
 * The fan's list of artists to come back to, split out of the old dashboard.
 *
 * The list itself lives in AuthContext — the same one the save buttons on search results and
 * artist pages read — so arriving here from a search costs no fetch at all, and a save made
 * anywhere is already reflected when you get here.
 */
export function SavedArtistsPage() {
  const {
    session,
    savedArtists,
    artistsLoaded,
    loadSavedArtists,
    removeSavedArtist,
    saveArtist,
    setArtistSupported,
  } = useAuth();

  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<SavedArtist | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    loadSavedArtists(controller.signal);
    return () => controller.abort();
  }, [session, loadSavedArtists]);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(timer);
  }, [undo]);

  const totalPages = Math.max(1, Math.ceil(savedArtists.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = savedArtists.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const goToPage = useCallback((next: number) => {
    setPage(Math.min(Math.max(1, next), totalPages));
  }, [totalPages]);

  async function handleRemove(artist: SavedArtist) {
    setError(null);
    // The row goes immediately (AuthContext is optimistic), but the Undo offer waits for the
    // server: a refused removal is rolled back, and "Removed X · Undo" over a row that's still
    // there is a lie about what happened. `artist` is captured now, before the list changes, so
    // Undo restores the notes and the artwork rather than a bare row.
    const removed = await removeSavedArtist(artist.artistId);
    if (removed) {
      setUndo(artist);
    } else {
      setError(`Couldn't remove ${artist.name}. Please try again.`);
    }
  }

  async function handleUndo(artist: SavedArtist) {
    setUndo(null);
    await saveArtist(artist.artistId, artist.notes, artist.name, artist.imageUrl);
    // saveArtist only restores the save. The supported mark is a separate record of something
    // the fan actually did, so it gets put back too rather than quietly dropped.
    if (artist.supported) {
      await setArtistSupported(artist.artistId, true).catch(() => {
        setError("Restored, but couldn't restore the supported mark. Try setting it again.");
      });
    }
  }

  async function handleToggleSupport(artist: SavedArtist) {
    setError(null);
    setBusySlug(artist.artistId);
    try {
      await setArtistSupported(artist.artistId, !artist.supported);
    } catch {
      setError('Failed to update support status. Please try again.');
    } finally {
      setBusySlug(null);
    }
  }

  const supportedCount = savedArtists.filter(a => a.supported).length;

  return (
    <AccountLayout
      title="Saved Artists"
      description={
        artistsLoaded && savedArtists.length > 0
          ? `${savedArtists.length} saved · ${supportedCount} supported`
          : undefined
      }
    >
      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {!artistsLoaded ? (
        <SkeletonScreen label="Loading your saved artists">
          <ArtistRowsSkeleton count={6} />
        </SkeletonScreen>
      ) : savedArtists.length === 0 ? (
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {visible.map(artist => (
              <div
                key={artist.artistId}
                className="p-4 rounded-lg bg-bg-secondary border border-border hover:border-border-hover transition-colors"
              >
                <div className="flex gap-4">
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
                      <p className="text-xs text-text-muted mt-2 line-clamp-2">{artist.notes}</p>
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
                        disabled={busySlug === artist.artistId}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                          artist.supported
                            ? 'bg-accent-secondary/15 border border-accent-secondary/40 text-accent-secondary hover:bg-accent-secondary/25'
                            : 'border border-border text-text-muted hover:text-text-primary hover:border-border-hover'
                        } ${busySlug === artist.artistId ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                        {artist.supported ? 'Supported' : 'Support'}
                      </button>
                      <button
                        onClick={() => handleRemove(artist)}
                        className="p-1.5 rounded-lg border border-border text-text-muted hover:text-red-400 hover:border-red-500/30 transition-colors"
                        title={`Remove ${artist.name}`}
                        aria-label={`Remove ${artist.name}`}
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

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <button
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-text-muted px-2">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {undo && (
        <div className="fixed bottom-6 right-6 z-50 pointer-events-auto px-4 py-3 rounded-lg bg-accent-primary/10 border border-accent-primary/20 text-accent-primary shadow-lg flex items-center gap-3">
          <span className="text-sm font-medium">Removed {undo.name}</span>
          <button
            onClick={() => handleUndo(undo)}
            className="px-3 py-1 rounded-md bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
          >
            Undo
          </button>
        </div>
      )}
    </AccountLayout>
  );
}
