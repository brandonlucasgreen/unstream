import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import * as Sentry from '@sentry/react';
import { getSupabaseClient, waitForMagicLinkSession } from '../services/auth';

const ADMIN_EMAIL = 'info@kidlightbulbs.com';

export interface SavedArtist {
  artistId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  notes?: string;
  addedAt: string;
  claimed?: boolean;
  supported?: boolean;
  supportedAt?: string;
}

/** A profile this user has claimed — what powers the "Your artists" nav section. */
export interface ClaimedProfile {
  id: string;
  artistId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  websiteUrl?: string;
  bio?: string;
  claimedAt: string;
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
  /** Resolves false when the server refused and the removal was rolled back. */
  removeSavedArtist: (artistId: string) => Promise<boolean>;
  setArtistSupported: (artistId: string, supported: boolean) => Promise<void>;
  loadSavedArtists: (signal?: AbortSignal) => Promise<void>;
  artistsLoaded: boolean;
  claimedProfiles: ClaimedProfile[];
  claimedProfilesLoaded: boolean;
  loadClaimedProfiles: (signal?: AbortSignal) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The server's own explanation of a rejected save/remove, for the Sentry report.
 *
 * Without it these reports said only "failed", which is what made a save that answered
 * 400 "Invalid artist slug format" on every single attempt look indistinguishable from a
 * flaky network. The status code goes on a tag so the issue page separates a client bug
 * (400) from an expired session (401) from a database outage (500) at a glance.
 */
async function describeFailure(response: Response): Promise<{ statusCode: number; serverError: string }> {
  let serverError = '(no body)';
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') serverError = body.error;
  } catch {
    // A non-JSON body is itself worth seeing, but not worth failing the report over.
  }
  return { statusCode: response.status, serverError };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [savedArtists, setSavedArtists] = useState<SavedArtist[]>([]);
  const [savedArtistIds, setSavedArtistIds] = useState<Set<string>>(new Set());
  const [artistsLoaded, setArtistsLoaded] = useState(false);
  const [claimedProfiles, setClaimedProfiles] = useState<ClaimedProfile[]>([]);
  const [claimedProfilesLoaded, setClaimedProfilesLoaded] = useState(false);

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

    // Supabase hands back a fresh Session object on every emission — tab focus,
    // cross-tab sync, token refresh — and its INITIAL_SESSION event lands right
    // after init() has already set an identical one. Setting state unconditionally
    // changed `session`'s *identity* each time, which re-fired every `[session]`
    // effect in the app: /settings refetched all six of its panels twice on a
    // single load, and repeat emissions spent the shared per-IP rate-limit budget
    // until the page 429'd on itself (Sentry UNSTREAM-WEB-12). Only a different
    // access token is a change worth propagating.
    function applySession(newSession: Session | null) {
      const tokenUnchanged = newSession?.access_token === sessionRef.current?.access_token;
      sessionRef.current = newSession;

      // The *user* propagates whether or not the token changed. Supabase fires
      // USER_UPDATED with fresh metadata on the same token — that's the event
      // updatePassword() produces when it sets has_password — so guarding this on the
      // token would leave `hasPassword` (line ~348) stale and PasswordSection showing
      // "Set password" to someone who had just set one. Safe to do unguarded because
      // nothing keys an *effect* on `user`: Header renders it, PasswordSection reads a
      // derived boolean. It costs a render, not a refetch. `session` is the identity
      // that six /settings panels fetch on, and that's the one the guard below protects.
      setUser(newSession?.user ?? null);

      if (tokenUnchanged) return;

      setSession(newSession);
      // Clear saved artists on sign out. This has to stay inside the guard —
      // `new Set()` is a new identity every call, so running it on a no-op
      // emission would recreate exactly the churn above.
      if (!newSession) {
        setSavedArtists([]);
        setSavedArtistIds(new Set());
        setArtistsLoaded(false);
        setClaimedProfiles([]);
        setClaimedProfilesLoaded(false);
      }
    }

    async function init() {
      // If URL has magic link hash, handle it before anything else
      if (window.location.hash.includes('access_token')) {
        const { session: magicSession } = await waitForMagicLinkSession();
        // Clear the hash from the URL
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        if (!cancelled && magicSession) {
          applySession(magicSession);
        }
      } else {
        // Check for existing session — fast, no domain data
        const { data } = await supabase!.auth.getSession();
        if (!cancelled && data.session) {
          applySession(data.session);
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
        applySession(newSession);
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
        const { statusCode, serverError } = await describeFailure(response);
        Sentry.captureMessage('Save artist failed (rolled back)', {
          level: 'warning',
          extra: { artistId, artistName, hasSession: !!session, serverError },
          tags: { context: 'auth.saveArtist', status_code: String(statusCode) },
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
    if (!session) return false;

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
        const { statusCode, serverError } = await describeFailure(response);
        Sentry.captureMessage('Remove artist failed (rolled back)', {
          level: 'warning',
          extra: { artistId, artistName: removedFromList?.name, hasSession: !!session, serverError },
          tags: { context: 'auth.removeSavedArtist', status_code: String(statusCode) },
        });
        // Rollback on error: restore both Set and array
        setSavedArtistIds(prev => new Set(prev).add(artistId));
        if (removedFromList) {
          setSavedArtists(prev => [...prev, removedFromList]);
        }
        return false;
      }
      return true;
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
      return false;
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
        const { statusCode, serverError } = await describeFailure(response);
        Sentry.captureMessage('Dashboard saved-artists load failed', {
          level: 'warning',
          extra: { statusCode, hasSession: !!session, serverError },
          tags: { context: 'auth.loadSavedArtists', status_code: String(statusCode) },
        });
      }
    } catch (e) {
      if (signal?.aborted) return;
      Sentry.captureException(e, { extra: { context: 'auth.loadSavedArtists' } });
      console.error('Failed to load saved artists');
    }
  }, [session, artistsLoaded]);

  /**
   * Mark a saved artist as supported, or take the mark off again.
   *
   * Optimistic like save/remove, and rolled back the same way — the button is a statement
   * about something the fan already did, so it should never sit spinning.
   */
  const setArtistSupported = useCallback(async (artistId: string, supported: boolean) => {
    if (!session) return;

    const previous = savedArtists.find(a => a.artistId === artistId);
    setSavedArtists(prev => prev.map(a =>
      a.artistId === artistId
        ? { ...a, supported, supportedAt: supported ? new Date().toISOString() : undefined }
        : a
    ));

    try {
      const response = await fetch('/api/saved-artists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: supported ? 'support' : 'unsupport', artistId }),
      });

      if (!response.ok) {
        const { statusCode, serverError } = await describeFailure(response);
        Sentry.captureMessage('Set supported failed (rolled back)', {
          level: 'warning',
          extra: { artistId, supported, serverError },
          tags: { context: 'auth.setArtistSupported', status_code: String(statusCode) },
        });
        throw new Error(serverError);
      }

      const data = await response.json();
      setSavedArtists(prev => prev.map(a =>
        a.artistId === artistId
          ? { ...a, supported: data.savedArtist.supported, supportedAt: data.savedArtist.supportedAt }
          : a
      ));
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.setArtistSupported' } });
      setSavedArtists(prev => prev.map(a =>
        a.artistId === artistId
          ? { ...a, supported: previous?.supported, supportedAt: previous?.supportedAt }
          : a
      ));
      throw e;
    }
  }, [session, savedArtists]);

  /**
   * The profiles this user has claimed. Loaded once per session, like the saved artists
   * above: the account sidebar lists them on every logged-in page, so refetching per
   * navigation would put /api/artist-auth on the same churn treadmill that made the
   * signed-in app 429 on itself (UNSTREAM-WEB-12).
   */
  const loadClaimedProfiles = useCallback(async (signal?: AbortSignal) => {
    if (!session) return;
    if (claimedProfilesLoaded) return;
    try {
      const response = await fetch('/api/artist-auth', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
        signal,
      });
      if (response.ok) {
        const data = await response.json();
        setClaimedProfiles(data.profiles || []);
        setClaimedProfilesLoaded(true);
      } else {
        const { statusCode, serverError } = await describeFailure(response);
        Sentry.captureMessage('Claimed profiles load failed', {
          level: 'warning',
          extra: { statusCode, serverError },
          tags: { context: 'auth.loadClaimedProfiles', status_code: String(statusCode) },
        });
      }
    } catch (e) {
      if (signal?.aborted) return;
      Sentry.captureException(e, { extra: { context: 'auth.loadClaimedProfiles' } });
    }
  }, [session, claimedProfilesLoaded]);

  const isAdmin = !!user?.email && user.email.toLowerCase() === ADMIN_EMAIL;
  const hasPassword = !!user?.user_metadata?.has_password;

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, isLoading, hasPassword, signOut: handleSignOut, signInWithMagicLink: handleSignInWithMagicLink, signInWithPassword: handleSignInWithPassword, savedArtists, savedArtistIds, isArtistSaved, saveArtist, removeSavedArtist, setArtistSupported, loadSavedArtists, artistsLoaded, claimedProfiles, claimedProfilesLoaded, loadClaimedProfiles }}>
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
