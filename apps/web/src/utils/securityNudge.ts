import type { User } from '@supabase/supabase-js';
import { hasVerifiedSecondFactor } from './mfa';

/** The `user_metadata` key that records the security nudge was dismissed. */
export const SECURITY_NUDGE_DISMISSED_KEY = 'security_nudge_dismissed_at';

/**
 * Whether /my-collection should nudge this account toward two-step
 * verification. Mirrors `shouldShowWelcome`: never for an account that already
 * has a second factor or has said no thanks, and dismissal is stored on the
 * account (user_metadata, user-writable — fine for a flag whose only effect is
 * hiding a banner) so it holds across devices.
 */
export function shouldShowSecurityNudge(user: User | null): boolean {
  if (!user) return false;
  if (user.user_metadata?.[SECURITY_NUDGE_DISMISSED_KEY]) return false;
  return !hasVerifiedSecondFactor(user);
}
