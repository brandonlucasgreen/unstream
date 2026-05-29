import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient, waitForMagicLinkSession } from '../services/auth';

const ADMIN_EMAIL = 'info@kidlightbulbs.com';

interface SavedArtist {
  artistId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  notes?: string;
  addedAt: string;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  isLoading: boolean;
  hasPassword: boolean;
  signOut: () => Promise<void>;
  savedArtists: SavedArtist[];
  savedArtistIds: Set<string>;
  isArtistSaved: (artistId: string) => boolean;
  saveArtist: (artistId: string, notes?: string) => Promise<void>;
  removeSavedArtist: (artistId: string) => Promise<void>;
  loadSavedArtists: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savedArtists, setSavedArtists] = useState<SavedArtist[]>([]);
  const [savedArtistIds, setSavedArtistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function init() {
      // If URL has magic link hash, handle it before anything else
      if (window.location.hash.includes('access_token')) {
        const { session: magicSession } = await waitForMagicLinkSession();
        // Clear the hash from the URL
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        if (!cancelled && magicSession) {
          setSession(magicSession);
          setUser(magicSession.user);
          // Load saved artists after login
          if (!cancelled) {
            await loadSavedArtists(magicSession);
          }
        }
      } else {
        // Check for existing session
        const { data } = await supabase!.auth.getSession();
        if (!cancelled && data.session) {
          setSession(data.session);
          setUser(data.session.user);
          // Load saved artists on restore
          if (!cancelled) {
            await loadSavedArtists(data.session);
          }
        }
      }

      if (!cancelled) setIsLoading(false);
    }

    // Load saved artists helper
    async function loadSavedArtists(sess: Session) {
      try {
        const response = await fetch('/api/saved-artists', {
          headers: { 'Authorization': `Bearer ${sess.access_token}` },
        });
        if (response.ok) {
          const data = await response.json();
          setSavedArtists(data.savedArtists || []);
          setSavedArtistIds(new Set(data.savedArtists?.map((a: SavedArtist) => a.artistId) || []));
        }
      } catch {
        console.error('Failed to load saved artists on init');
      }
    }

    init();

    // Listen for auth state changes (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!cancelled) {
        setSession(newSession);
        setUser(newSession?.user ?? null);
        if (newSession) {
          // Load saved artists on login
          loadSavedArtists(newSession);
        } else {
          setSavedArtists([]);
          setSavedArtistIds(new Set());
        }
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const handleSignOut = useCallback(async () => {
    const supabase = getSupabaseClient();
    if (supabase) {
      await supabase.auth.signOut();
    }
    setSavedArtists([]);
    setSavedArtistIds(new Set());
    // onAuthStateChange listener will clear session/user
  }, []);

  const isArtistSaved = useCallback((artistId: string) => savedArtistIds.has(artistId), [savedArtistIds]);

  const saveArtist = useCallback(async (artistId: string, notes?: string) => {
    if (!session) return;

    // Optimistic update
    setSavedArtistIds(prev => new Set(prev).add(artistId));

    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ artistId, notes }),
      });

      if (response.ok) {
        const data = await response.json();
        setSavedArtists(prev => [...prev, data.savedArtist]);
      } else {
        // Rollback on error
        setSavedArtistIds(prev => {
          const next = new Set(prev);
          next.delete(artistId);
          return next;
        });
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to save artist');
      }
    } catch (error) {
      console.error('Failed to save artist:', error);
    }
  }, [session]);

  const removeSavedArtist = useCallback(async (artistId: string) => {
    if (!session) return;

    // Optimistic update
    setSavedArtistIds(prev => {
      const next = new Set(prev);
      next.delete(artistId);
      return next;
    });

    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        body: JSON.stringify({ action: 'remove', artistId }),
      });

      if (response.ok) {
        setSavedArtists(prev => prev.filter(a => a.artistId !== artistId));
      } else {
        // Rollback on error
        setSavedArtistIds(prev => new Set(prev).add(artistId));
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to remove artist');
      }
    } catch (error) {
      console.error('Failed to remove artist:', error);
    }
  }, [session]);

  // Check localStorage for pending save
  useEffect(() => {
    if (session) {
      const pendingSave = localStorage.getItem('pendingSave');
      if (pendingSave) {
        try {
          const { artistId, notes } = JSON.parse(pendingSave);
          saveArtist(artistId, notes);
          localStorage.removeItem('pendingSave');
          // Show toast via window event or store - for now, we just save
        } catch {
          localStorage.removeItem('pendingSave');
        }
      }
    }
  }, [session, saveArtist]);

  const loadSavedArtists = useCallback(async () => {
    if (!session) return;
    await loadSavedArtistsInternal(session);
  }, [session]);

  async function loadSavedArtistsInternal(sess: Session) {
    try {
      const response = await fetch('/api/saved-artists', {
        headers: { 'Authorization': `Bearer ${sess.access_token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setSavedArtists(data.savedArtists || []);
        setSavedArtistIds(new Set(data.savedArtists?.map((a: SavedArtist) => a.artistId) || []));
      }
    } catch {
      console.error('Failed to load saved artists');
    }
  }

  const isAdmin = !!user?.email && user.email.toLowerCase() === ADMIN_EMAIL;
  const hasPassword = !!user?.user_metadata?.has_password;

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, isLoading, hasPassword, signOut: handleSignOut, savedArtists, savedArtistIds, isArtistSaved, saveArtist, removeSavedArtist, loadSavedArtists }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
