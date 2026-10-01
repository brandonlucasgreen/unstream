import type { User } from '@supabase/supabase-js';

/**
 * How long after sign-up the dashboard welcome is still offered.
 *
 * The banner is for new accounts, and "new" has to be decided from the user record alone:
 * a magic link can't say whether it's creating an account or signing into one, since
 * `signInWithOtp` does both. Without a window, every account that existed before the banner
 * shipped would be greeted as a newcomer on its next visit. A week covers someone who signs
 * up and doesn't come back to the dashboard for a few days.
 */
export const WELCOME_WINDOW_DAYS = 7;

/** The `user_metadata` key that records the banner was dismissed. */
export const WELCOME_DISMISSED_KEY = 'welcome_dismissed_at';

/**
 * Whether the dashboard should greet this user. Dismissal is stored on the account rather
 * than in localStorage so it holds across devices; `user_metadata` is user-writable, which is
 * fine for a flag whose only effect is hiding a banner.
 */
export function shouldShowWelcome(user: User | null, now: number = Date.now()): boolean {
  if (!user) return false;
  if (user.user_metadata?.[WELCOME_DISMISSED_KEY]) return false;

  const createdAt = Date.parse(user.created_at);
  if (Number.isNaN(createdAt)) return false;

  return now - createdAt < WELCOME_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
