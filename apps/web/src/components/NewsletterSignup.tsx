import { useState } from 'react';
import * as Sentry from '@sentry/react';

type Status = 'idle' | 'submitting' | 'pending' | 'already_subscribed' | 'error';

interface NewsletterSignupProps {
  /** Where the signup happened. Sent to Buttondown as a tag; the API rejects anything else. */
  source: 'changelog' | 'guides' | 'contact';
  heading?: string;
  blurb: string;
  /** Absolute or root-relative URL of the matching RSS feed, offered as the no-email option. */
  feedUrl?: string;
  feedLabel?: string;
}

/**
 * Email signup for the Unstream newsletter.
 *
 * Posts to our own /api/newsletter/subscribe, which talks to Buttondown server-side — see
 * api/functions/newsletter-subscribe.ts for why it isn't Buttondown's embed.
 *
 * Signup is **double opt-in**, so success here means "check your inbox", not "you're on the
 * list". The copy says so: telling someone they're subscribed when a confirmation email is
 * still sitting unread is how people conclude the newsletter is broken.
 */
export function NewsletterSignup({
  source,
  heading,
  blurb,
  feedUrl,
  feedLabel = 'RSS feed',
}: NewsletterSignupProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  const done = status === 'pending' || status === 'already_subscribed';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === 'submitting') return;

    setStatus('submitting');
    setError(null);

    try {
      const res = await fetch('/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), source }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        setStatus('error');
        return;
      }

      setStatus(data.status === 'already_subscribed' ? 'already_subscribed' : 'pending');
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'NewsletterSignup.submit', source } });
      setError('Something went wrong. Please try again.');
      setStatus('error');
    }
  }

  const inputId = `newsletter-email-${source}`;

  return (
    <div className="space-y-3">
      <div>
        {heading && (
          <h2 className="font-display text-lg font-semibold text-text-primary mb-1">{heading}</h2>
        )}
        <p className="text-text-secondary text-sm">{blurb}</p>
      </div>

      {done ? (
        // aria-live so the confirmation reaches a screen reader: the form it replaces is
        // where focus was, and swapping it out is silent otherwise.
        <p className="text-sm text-text-primary" role="status">
          {status === 'already_subscribed'
            ? "You're already on the list — nothing more to do."
            : 'Almost there: check your inbox for a link to confirm your subscription.'}
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-2">
          <label htmlFor={inputId} className="sr-only">
            Email address
          </label>
          {/* min-w-0 on the input, not the wrapper: a flex item's default min-width is its
              content, so without it a long address pushes the button off the edge. */}
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id={inputId}
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={status === 'submitting'}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-bg-primary border border-border text-sm text-text-primary placeholder:text-text-muted disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={status === 'submitting'}
              className="px-4 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 shrink-0"
            >
              {status === 'submitting' ? 'Subscribing…' : 'Subscribe'}
            </button>
          </div>

          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}

          <p className="text-xs text-text-muted">
            No spam, unsubscribe any time. We'll email you a link to confirm first.
          </p>
        </form>
      )}

      {feedUrl && (
        <p className="text-xs text-text-muted">
          Rather not use email?{' '}
          <a href={feedUrl} className="text-accent-primary hover:underline">
            Subscribe to the {feedLabel}
          </a>
          .
        </p>
      )}
    </div>
  );
}
