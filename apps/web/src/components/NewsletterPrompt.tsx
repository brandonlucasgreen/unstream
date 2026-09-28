import { useState } from 'react';
import * as Sentry from '@sentry/react';
import { LIGHTBULBS_ON_BLURB } from '../data/newsletter';
import type { NewsletterSource } from './NewsletterSignup';
import {
  subscribeToNewsletter,
  newsletterPromptAnswered,
  markNewsletterPromptAnswered,
} from '../services/newsletter';

interface NewsletterPromptProps {
  email: string | undefined;
  source: Extract<NewsletterSource, 'artist' | 'unstream'>;
}

/**
 * A one-time Lightbulbs On invitation on /dashboard and /artist-dashboard. It's how fans are asked
 * at all (the sign-in page doesn't ask, see NewsletterCheckbox) and how accounts from before the
 * claim-flow checkbox are asked. Shown until they subscribe or say no thanks, then never again on
 * this browser.
 */
export function NewsletterPrompt({ email, source }: NewsletterPromptProps) {
  const [answered, setAnswered] = useState(newsletterPromptAnswered);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');

  if (!email || (answered && status !== 'done')) return null;

  async function subscribe() {
    if (!email) return;
    setStatus('submitting');
    try {
      await subscribeToNewsletter(email, source);
      markNewsletterPromptAnswered('subscribed');
      setStatus('done');
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'NewsletterPrompt.subscribe', source } });
      setStatus('error');
    }
  }

  function dismiss() {
    markNewsletterPromptAnswered('dismissed');
    setAnswered(true);
  }

  return (
    <div className="rounded-xl border border-border bg-surface-secondary p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      {status === 'done' ? (
        <p className="text-sm text-text-secondary" aria-live="polite">
          Check your inbox for a confirmation email from Lightbulbs On.
        </p>
      ) : (
        <>
          <p className="text-sm text-text-secondary flex-1">
            {status === 'error' ? 'Something went wrong. Please try again.' : LIGHTBULBS_ON_BLURB}
          </p>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={subscribe}
              disabled={status === 'submitting'}
              className="px-3 py-1.5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
            >
              {status === 'submitting' ? 'Subscribing...' : 'Subscribe'}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="px-3 py-1.5 rounded-lg text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              No thanks
            </button>
          </div>
        </>
      )}
    </div>
  );
}
