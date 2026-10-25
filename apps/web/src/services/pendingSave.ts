// A save a signed-out fan asked for, held across the sign-in that has to happen first.
//
// Written by LoginInterstitial before it sends a magic link or signs in, read back by AuthContext
// once a session exists. It is cleared only after the save is confirmed: it used to be deleted
// the moment it was read, so a save that failed after sign-in (expired token, 500, offline) left
// the fan signed in, the artist unsaved, and nothing on screen to say so.

const PENDING_SAVE_KEY = 'pendingSave';

export interface PendingSave {
  /** The card's save key — claimedSlug || knownSlug || id, never a pipeline id alone. */
  artistId: string;
  artistName?: string;
  artistImageUrl?: string;
  notes?: string;
}

// Every access is guarded: storage can be missing or throw (private windows, blocked site data),
// and a failure here must never break sign-in.

export function writePendingSave(pending: PendingSave): void {
  try {
    localStorage.setItem(PENDING_SAVE_KEY, JSON.stringify(pending));
  } catch {
    // Nothing to fall back to; the fan can save again after signing in.
  }
}

/** The stored request, or null. A corrupt entry is cleared rather than retried forever. */
export function readPendingSave(): PendingSave | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PENDING_SAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.artistId === 'string' && parsed.artistId) return parsed as PendingSave;
  } catch {
    // Fall through to clearing it.
  }
  clearPendingSave();
  return null;
}

export function clearPendingSave(): void {
  try {
    localStorage.removeItem(PENDING_SAVE_KEY);
  } catch {
    // Already unreadable; nothing to clear.
  }
}
