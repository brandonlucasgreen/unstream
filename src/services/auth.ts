// Supabase client-side auth for artist claim flow.
// Uses the anon key (safe to expose) — RLS policies control access.

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

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

  return { error: error?.message ?? null };
}

export async function getSession(): Promise<Session | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}
