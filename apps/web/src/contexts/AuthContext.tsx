import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient, waitForMagicLinkSession } from '../services/auth';

const ADMIN_EMAIL = 'info@kidlightbulbs.com';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  isAdmin: boolean;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
        }
      } else {
        // Check for existing session
        const { data } = await supabase!.auth.getSession();
        if (!cancelled && data.session) {
          setSession(data.session);
          setUser(data.session.user);
        }
      }

      if (!cancelled) setIsLoading(false);
    }

    init();

    // Listen for auth state changes (sign in, sign out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!cancelled) {
        setSession(newSession);
        setUser(newSession?.user ?? null);
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
    // onAuthStateChange listener will clear session/user
  }, []);

  const isAdmin = !!user?.email && user.email.toLowerCase() === ADMIN_EMAIL;

  return (
    <AuthContext.Provider value={{ session, user, isAdmin, isLoading, signOut: handleSignOut }}>
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
