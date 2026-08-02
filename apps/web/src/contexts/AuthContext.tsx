import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import * as Sentry from '@sentry/react';
import { getSupabaseClient, waitForMagicLinkSession } from '../services/auth';

const ADMIN_EMAIL = 'info@kidlightbulbs.com';

interface SavedArtist {
  artistId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  notes?: string;
  addedAt: string;
  claimed?: boolean;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  isLoading: boolean;
  hasPassword: boolean;
  signOut: () => Promise<void>;
  signInWithMagicLink: (email: string) => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  savedArtists: SavedArtist[];
  savedArtistIds: Set<string>;
  isArtistSaved: (artistId: string) => boolean;
  saveArtist: (artistId: string, notes?: string, artistName?: string, artistImageUrl?: string) => Promise<void>;
  removeSavedArtist: (artistId: string) => Promise<void>;
  loadSavedArtists: (signal?: AbortSignal) => Promise<void>;
  artistsLoaded: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savedArtists, setSavedArtists] = useState<SavedArtist[]>([]);
  const [savedArtistIds, setSavedArtistIds] = useState<Set<string>>(new Set());
  const [artistsLoaded, setArtistsLoaded] = useState(false);

  // The auth listener below is installed once, so it cannot read `session` state:
  // that closure is pinned to the initial null forever, which is why the
  // "session ended unexpectedly" report has never fired a single time. A ref
  // holds the live value instead.
  const sessionRef = useRef<Session | null>(null);
  // Set while our own signOut() runs, so a deliberate sign-out isn't reported as
  // a session dropping out from under the user.
  const signingOutRef = useRef(false);

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
          sessionRef.current = magicSession;
          setSession(magicSession);
          setUser(magicSession.user);
        }
      } else {
        // Check for existing session — fast, no domain data
        const { data } = await supabase!.auth.getSession();
        if (!cancelled && data.session) {
          sessionRef.current = data.session;
          setSession(data.session);
          setUser(data.session.user);
        }
      }

      if (!cancelled) setIsLoading(false);
    }

    init();

    // Listen for auth state changes (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!cancelled) {
        const previous = sessionRef.current;
        if (newSession === null && previous !== null && !signingOutRef.current) {
          Sentry.captureMessage('Auth session ended unexpectedly', {
            level: 'warning',
            extra: {
              previousUserId: previous.user?.id,
              previousExpiry: previous.expires_at,
              // Whether the token was already past its expiry when it dropped
              // separates an ordinary expiry from a session vanishing early.
              expiredBeforeDrop: previous.expires_at
                ? previous.expires_at * 1000 < Date.now()
                : null,
            },
            tags: { context: 'auth.session', auth_event: event },
          });
        }
        sessionRef.current = newSession;
        setSession(newSession);
        setUser(newSession?.user ?? null);
        // Clear saved artists on sign out
        if (!newSession) {
          setSavedArtists([]);
          setSavedArtistIds(new Set());
          setArtistsLoaded(false);
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
    signingOutRef.current = true;
    try {
      if (supabase) {
        await supabase.auth.signOut();
      }
    } finally {
      signingOutRef.current = false;
    }
    setSavedArtists([]);
    setSavedArtistIds(new Set());
    // onAuthStateChange listener will clear session/user
  }, []);

  const handleSignInWithMagicLink = useCallback(async (email: string) => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Auth not available');
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) {
      Sentry.captureMessage('Magic link sign-in failed', {
        level: 'warning',
        extra: { errorMessage: error.message, errorCode: error.status },
        tags: { context: 'auth.magicLink' },
      });
      throw error;
    }
  }, []);

  const handleSignInWithPassword = useCallback(async (email: string, password: string) => {
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Auth not available');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, []);

  const isArtistSaved = useCallback((artistId: string) => savedArtistIds.has(artistId), [savedArtistIds]);

  const saveArtist = useCallback(async (artistId: string, notes?: string, artistName?: string, artistImageUrl?: string) => {
    if (!session) return;

    // Skip if already saved (dedup)
    if (savedArtistIds.has(artistId)) return;

    // Optimistic update
    setSavedArtistIds(prev => new Set(prev).add(artistId));

    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ artistId, notes, name: artistName, imageUrl: artistImageUrl }),
      });

      if (response.ok) {
        const data = await response.json();
        setSavedArtists(prev => [...prev, data.savedArtist]);
      } else {
        Sentry.captureMessage('Save artist failed (rolled back)', {
          level: 'warning',
          extra: { artistId, artistName, hasSession: !!session },
          tags: { context: 'auth.saveArtist' },
        });
        // Rollback on error: remove from both Set and array
        setSavedArtistIds(prev => {
          const next = new Set(prev);
          next.delete(artistId);
          return next;
        });
        setSavedArtists(prev => prev.filter(a => a.artistId !== artistId));
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.saveArtist' } });
      Sentry.captureMessage('Save artist failed (rolled back)', {
        level: 'warning',
        extra: { artistId, artistName, hasSession: !!session },
        tags: { context: 'auth.saveArtist' },
      });
      // Rollback on network error
      setSavedArtistIds(prev => {
        const next = new Set(prev);
        next.delete(artistId);
        return next;
      });
      setSavedArtists(prev => prev.filter(a => a.artistId !== artistId));
    }
  }, [session, savedArtistIds]);

  const removeSavedArtist = useCallback(async (artistId: string) => {
    if (!session) return;

    // Snapshot for rollback
    const removedFromList = savedArtists.find(a => a.artistId === artistId);

    // Optimistic update: remove from both Set and array
    setSavedArtistIds(prev => {
      const next = new Set(prev);
      next.delete(artistId);
      return next;
    });
    setSavedArtists(prev => prev.filter(a => a.artistId !== artistId));

    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: 'remove', artistId }),
      });

      if (!response.ok) {
        Sentry.captureMessage('Remove artist failed (rolled back)', {
          level: 'warning',
          extra: { artistId, artistName: removedFromList?.name, hasSession: !!session },
          tags: { context: 'auth.removeSavedArtist' },
        });
        // Rollback on error: restore both Set and array
        setSavedArtistIds(prev => new Set(prev).add(artistId));
        if (removedFromList) {
          setSavedArtists(prev => [...prev, removedFromList]);
        }
      }
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.removeSavedArtist' } });
      Sentry.captureMessage('Remove artist failed (rolled back)', {
        level: 'warning',
        extra: { artistId, artistName: removedFromList?.name, hasSession: !!session },
        tags: { context: 'auth.removeSavedArtist' },
      });
      // Rollback on network error
      setSavedArtistIds(prev => new Set(prev).add(artistId));
      if (removedFromList) {
        setSavedArtists(prev => [...prev, removedFromList]);
      }
    }
  }, [session, savedArtists]);

  // Check localStorage for pending save (from unauthenticated clicks)
  useEffect(() => {
    if (session) {
      const pendingSave = localStorage.getItem('pendingSave');
      if (pendingSave) {
        try {
          const { artistId, notes } = JSON.parse(pendingSave);
          localStorage.removeItem('pendingSave'); // Clear immediately to prevent retries
          saveArtist(artistId, notes);
        } catch {
          localStorage.removeItem('pendingSave');
        }
      }
    }
  }, [session, saveArtist]);

  const loadSavedArtists = useCallback(async (signal?: AbortSignal) => {
    if (!session) return;
    if (artistsLoaded) return;
    try {
      const response = await fetch('/api/saved-artists', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
        signal,
      });
      if (response.ok) {
        const data = await response.json();
        setSavedArtists(data.savedArtists || []);
        setSavedArtistIds(new Set((data.savedArtists || []).map((a: SavedArtist) => a.artistId)));
        setArtistsLoaded(true);
      } else {
        Sentry.captureMessage('Dashboard saved-artists load failed', {
          level: 'warning',
          extra: { statusCode: response.status, hasSession: !!session },
          tags: { context: 'auth.loadSavedArtists' },
        });
      }
    } catch (e) {
      if (signal?.aborted) return;
      Sentry.captureException(e, { extra: { context: 'auth.loadSavedArtists' } });
      console.error('Failed to load saved artists');
    }
  }, [session, artistsLoaded]);

  const isAdmin = !!user?.email && user.email.toLowerCase() === ADMIN_EMAIL;
  const hasPassword = !!user?.user_metadata?.has_password;

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, isLoading, hasPassword, signOut: handleSignOut, signInWithMagicLink: handleSignInWithMagicLink, signInWithPassword: handleSignInWithPassword, savedArtists, savedArtistIds, isArtistSaved, saveArtist, removeSavedArtist, loadSavedArtists, artistsLoaded }}>
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
