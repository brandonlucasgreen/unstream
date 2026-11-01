import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { dismissSecurityNudge } from '../services/auth';
import { shouldShowSecurityNudge } from '../utils/securityNudge';

/**
 * A one-time nudge toward two-step verification, at the top of /my-collection.
 * Shown while the account has no second factor; never again once dismissed (the
 * flag lives on the account, like WelcomeBanner's) or after a factor is
 * enrolled. The link lands on the /settings section that does the enrolling.
 */
export function SecurityNudgeBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !shouldShowSecurityNudge(user)) return null;

  function handleDismiss() {
    setDismissed(true);
    void dismissSecurityNudge();
  }

  return (
    <section
      aria-labelledby="security-nudge-heading"
      className="p-4 rounded-xl bg-accent-secondary/10 border border-accent-secondary/20 flex items-start justify-between gap-4"
    >
      <div className="space-y-1">
        <h2 id="security-nudge-heading" className="font-semibold text-text-primary">
          Safeguard your account
        </h2>
        <p className="text-sm text-text-secondary">
          Add a second step to signing in — a code from an authenticator app — so a
          stolen password isn't enough for someone to take over your account.{' '}
          <Link to="/settings#two-step" className="text-link hover:underline">
            Set it up
          </Link>{' '}
          (it takes about a minute).
        </p>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        className="text-text-muted hover:text-text-primary transition-colors text-lg leading-none"
        aria-label="Dismiss account security suggestion"
      >
        ✕
      </button>
    </section>
  );
}
