// Supabase client-side auth for artist claim flow.
// Uses the anon key (safe to expose) — RLS policies control access.

import { createClient, type SupabaseClient, type Session, type AuthError } from '@supabase/supabase-js';
import * as Sentry from '@sentry/react';

let client: SupabaseClient | null = null;

/**
 * Report an auth failure that Supabase *returned* rather than threw.
 *
 * Every function here hands back `{ error }`, so callers surface the message in
 * the UI and their try/catch never runs — which meant no failed sign-in has ever
 * reached Sentry. Wrong-password is excluded deliberately: it's the user's typo,
 * it happens constantly, and burying the real failures under it defeats the point.
 * What's left is the set worth waking up to — rate limits, disabled providers,
 * Supabase 5xx, and network failures during sign-in.
 */
function reportAuthFailure(operation: string, error: AuthError): void {
  if (error.message === 'Invalid login credentials') return;

  Sentry.captureMessage(`Auth failed: ${operation}`, {
    level: 'warning',
    tags: { context: 'auth.service', auth_operation: operation, auth_status: String(error.status ?? 'none') },
    extra: { errorMessage: error.message, errorCode: error.code, errorName: error.name },
  });
}

export function getSupabaseClient(): SupabaseClient | null {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return null;

  client = createClient(url, anonKey);
  return client;
}

export async function signInWithMagicLink(email: string, redirectTo: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });

  if (error) reportAuthFailure('magicLink', error);
  return { error: error?.message ?? null };
}

export async function getSession(): Promise<Session | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data } = await supabase.auth.getSession();
  return data.session;
}

/**
 * Wait for a session to be established from a magic link callback.
 * Uses onAuthStateChange to reliably detect when Supabase processes the
 * access_token hash fragment, with a timeout fallback.
 */
export function waitForMagicLinkSession(timeoutMs = 5000): Promise<{ session: Session | null; error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return Promise.resolve({ session: null, error: 'Auth not configured' });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      subscription.unsubscribe();
      resolve({ session: null, error: 'Sign-in link may have expired or already been used. Please request a new one.' });
    }, timeoutMs);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        clearTimeout(timeout);
        subscription.unsubscribe();
        resolve({ session, error: null });
      } else if (event === 'TOKEN_REFRESHED' && session) {
        clearTimeout(timeout);
        subscription.unsubscribe();
        resolve({ session, error: null });
      }
    });

    // Also check if a session is already available (processed before listener attached)
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        clearTimeout(timeout);
        subscription.unsubscribe();
        resolve({ session: data.session, error: null });
      }
    });
  });
}

export async function signInWithPassword(email: string, password: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) reportAuthFailure('passwordLogin', error);
  return { error: error?.message ?? null };
}

export async function resetPasswordForEmail(email: string, redirectTo: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) reportAuthFailure('resetPassword', error);
  return { error: error?.message ?? null };
}

export async function updatePassword(newPassword: string): Promise<{ error: string | null }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { error: 'Auth not configured' };

  const { error } = await supabase.auth.updateUser({
    password: newPassword,
    data: { has_password: true },
  });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}
