import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import type { SavedArtist } from '../contexts/AuthContext';
import { SkeletonScreen } from './Skeleton';
import { ArtistRowsSkeleton } from './LoadingSkeletons';

// The fan half of the dashboard: artists saved to come back to, and which of them have
// actually been supported.
//
// The list comes from AuthContext — the same one the save buttons on search results and
// artist pages read — rather than a second copy fetched here. Two copies is how removing an
// artist on this page left the heart on a search result still filled in for the rest of the
// session: the dashboard mutated its own array and nothing told the context.

const PAGE_SIZE = 10;

export function SavedArtistsSection() {
  const { session, savedArtists, artistsLoaded, savedArtistsError, loadSavedArtists, removeSavedArtist, saveArtist, setArtistSupported } = useAuth();

  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<SavedArtist | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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
  // Clamped rather than corrected in state: a removal that empties the last page should show
  // the new last page on this render, not after a second one.
  const currentPage = Math.min(page, totalPages);
  const visible = savedArtists.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  async function handleRemove(artist: SavedArtist) {
    setError(null);
    // The row goes immediately — the context is optimistic — but the Undo offer waits for the
    // server. A refused removal is rolled back, and "Removed X · Undo" above a row that is
    // still there misdescribes what happened.
    const removed = await removeSavedArtist(artist.artistId);
    if (removed) {
      setUndo(artist);
    } else {
      setError('Failed to remove artist. Please try again.');
    }
  }

  async function handleUndo(artist: SavedArtist) {
    setUndo(null);
    const restored = await saveArtist(artist.artistId, artist.notes, artist.name, artist.imageUrl);
    if (!restored) {
      setError(`Couldn't restore ${artist.name}. Search for them to save them again.`);
      return;
    }
    // Restoring the save doesn't restore the supported mark, and that mark records something
    // the fan actually did — so it goes back too rather than being quietly dropped. The two
    // calls aren't atomic and can't be: they're two writes to one row through an endpoint
    // that takes one action at a time. What matters is that a half-done restore says which
    // half — checking `restored` first is why this message can't blame the mark for a save
    // that never landed.
    if (artist.supported) {
      try {
        await setArtistSupported(artist.artistId, true);
      } catch {
        setError(`Restored ${artist.name}, but not the supported mark. Press Support to set it again.`);
      }
    }
  }

  async function handleToggleSupport(artist: SavedArtist) {
    setError(null);
    setBusyId(artist.artistId);
    try {
      await setArtistSupported(artist.artistId, !artist.supported);
    } catch {
      setError('Failed to update support status. Please try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <svg className="w-5 h-5 text-accent-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
        </svg>
        Saved Artists
      </h2>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {!artistsLoaded && savedArtistsError ? (
        /*
          Not a skeleton. `artistsLoaded` stays false when the load fails — deliberately, so an
          empty list is never presented as "you have saved nobody" — which would leave this
          section shimmering forever. The old page-level error is what covered this before the
          sections became independent.
        */
        <div className="text-center py-12 rounded-lg border border-border border-dashed">
          <p className="text-text-muted">{savedArtistsError}</p>
          <button
            onClick={() => loadSavedArtists()}
            className="mt-4 px-4 py-2 rounded-lg border border-border text-sm text-text-primary hover:border-border-hover transition-colors"
          >
            Try again
          </button>
        </div>
      ) : !artistsLoaded ? (
        <SkeletonScreen label="Loading your saved artists">
          <ArtistRowsSkeleton count={4} />
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
                        disabled={busyId === artist.artistId}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                          artist.supported
                            ? 'bg-accent-secondary/15 border border-accent-secondary/40 text-accent-secondary hover:bg-accent-secondary/25'
                            : 'border border-border text-text-muted hover:text-text-primary hover:border-border-hover'
                        } ${busyId === artist.artistId ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                        title="Remove"
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
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="px-3 py-1.5 rounded-lg border border-border text-text-muted text-sm hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-text-muted px-2">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={() => setPage(currentPage + 1)}
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
        <div className="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg bg-accent-primary/10 border border-accent-primary/20 text-accent-primary shadow-lg flex items-center gap-3">
          <span className="text-sm font-medium">Removed {undo.name}</span>
          <button
            onClick={() => handleUndo(undo)}
            className="px-3 py-1 rounded-md bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors"
          >
            Undo
          </button>
        </div>
      )}
    </section>
  );
}
