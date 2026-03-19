import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'unstream_saved_artists';

interface SavedArtist {
  slug: string;
  name: string;
  imageUrl?: string;
  savedAt: string; // ISO date
}

// External store so all components share the same state
let listeners: Array<() => void> = [];
function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}

function getSnapshot(): string {
  return localStorage.getItem(STORAGE_KEY) || '[]';
}

function getSavedArtists(): SavedArtist[] {
  try {
    return JSON.parse(getSnapshot());
  } catch {
    return [];
  }
}

function setSavedArtists(artists: SavedArtist[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(artists));
  emitChange();
}

export function useSavedArtists() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => '[]');
  const artists: SavedArtist[] = JSON.parse(raw);

  const isSaved = useCallback((slug: string) => {
    return artists.some(a => a.slug === slug);
  }, [artists]);

  const toggleSave = useCallback((slug: string, name: string, imageUrl?: string) => {
    const current = getSavedArtists();
    const exists = current.some(a => a.slug === slug);
    if (exists) {
      setSavedArtists(current.filter(a => a.slug !== slug));
    } else {
      setSavedArtists([...current, { slug, name, imageUrl, savedAt: new Date().toISOString() }]);
    }
  }, []);

  const removeSaved = useCallback((slug: string) => {
    setSavedArtists(getSavedArtists().filter(a => a.slug !== slug));
  }, []);

  return { artists, isSaved, toggleSave, removeSaved };
}
