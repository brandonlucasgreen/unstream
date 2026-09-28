import type { NewsletterSource } from '../components/NewsletterSignup';

/**
 * Subscribe an address to Lightbulbs On through /api/newsletter/subscribe.
 *
 * Buttondown runs a double opt-in, so success means a confirmation email is on its way, not that
 * the address is on the list. Throws on any failure so the caller decides whether that's worth
 * showing: the signup checkboxes report it to Sentry and carry on, because a newsletter hiccup
 * must never block someone signing in.
 */
export async function subscribeToNewsletter(
  email: string,
  source: NewsletterSource,
): Promise<'pending' | 'already_subscribed'> {
  const res = await fetch('/api/newsletter/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), source }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Newsletter signup failed (${res.status})`);
  return data.status === 'already_subscribed' ? 'already_subscribed' : 'pending';
}

// Whether this browser has already answered the one-time Lightbulbs On prompt. Per-device on
// purpose: Buttondown can't be asked "is this address subscribed?" without an API call per page
// view, and the worst case of a cleared or blocked storage is seeing the prompt once more.
const PROMPT_KEY = 'lightbulbsOnPrompt';

export function newsletterPromptAnswered(): boolean {
  try {
    return localStorage.getItem(PROMPT_KEY) !== null;
  } catch {
    return false;
  }
}

export function markNewsletterPromptAnswered(answer: 'subscribed' | 'dismissed'): void {
  try {
    localStorage.setItem(PROMPT_KEY, answer);
  } catch {
    // Private mode or blocked storage: the prompt may come back, which is harmless.
  }
}
