import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { dismissWelcome } from '../services/auth';
import { shouldShowWelcome } from '../utils/welcome';

/**
 * A one-time greeting at the top of the dashboard for a newly created account.
 *
 * Sign-up is a magic link, so before this a new fan confirmed their email and landed on a
 * page with no acknowledgement that anything had happened. Hides immediately on dismiss; the
 * write to the account happens behind it, and if that fails (reported to Sentry by
 * `dismissWelcome`) the banner comes back on a later visit rather than nagging now.
 */
export function WelcomeBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !shouldShowWelcome(user)) return null;

  function handleDismiss() {
    setDismissed(true);
    void dismissWelcome();
  }

  return (
    <section
      aria-labelledby="welcome-heading"
      className="p-4 rounded-xl bg-accent-secondary/10 border border-accent-secondary/20 flex items-start justify-between gap-4"
    >
      <div className="space-y-1">
        <h2 id="welcome-heading" className="font-semibold text-text-primary">
          Welcome to Unstream
        </h2>
        <p className="text-sm text-text-secondary">
          Your email is confirmed and you're signed in. This is your dashboard: artists you
          save show up here, along with their new releases, so you know when there's something
          to support.{' '}
          <Link to="/" className="text-accent-primary hover:underline">
            Search for an artist
          </Link>{' '}
          to get started.
        </p>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none"
        aria-label="Dismiss welcome message"
      >
        ✕
      </button>
    </section>
  );
}
