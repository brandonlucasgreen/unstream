import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { getTipsAvailable } from '../services/tips';

// The top of the artist settings area (/artist-edit/:slug and its tabs): the artist's name, a link to
// their live page, and the three tabs. Each tab is its own route, so a tab can be linked to directly —
// Stripe sends an artist back to /artist-edit/:slug/tips after onboarding.

export type ArtistSettingsTab = 'profile' | 'tips' | 'releases';

const TABS: Array<{ id: ArtistSettingsTab; label: string; path: string }> = [
  { id: 'profile', label: 'Edit Profile', path: '' },
  { id: 'tips', label: 'Manage Tips', path: '/tips' },
  { id: 'releases', label: 'Manage Releases', path: '/releases' },
];

export function ArtistSettingsHeader({ slug, artistName, active }: {
  slug: string;
  /** Undefined while the page is still loading it. */
  artistName?: string;
  active: ArtistSettingsTab;
}) {
  const token = useAuth().session?.access_token;
  // Tips ship dark: the tab appears only once the server has a Stripe key. Asked once per visit —
  // this header stays mounted across tab switches. On the tips tab itself the tab always shows; the
  // page has its own "not available" state.
  const [tipsAvailable, setTipsAvailable] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // A failed check hides the tab rather than breaking the page, and is reported.
    getTipsAvailable(token)
      .then(available => { if (!cancelled) setTipsAvailable(available === true); })
      .catch(err => Sentry.captureException(err, { extra: { context: 'ArtistSettingsHeader.tipsAvailable' } }));
    return () => { cancelled = true; };
  }, [token]);

  const tabs = TABS.filter(tab => tab.id !== 'tips' || tipsAvailable || active === 'tips');

  return (
    <div className="space-y-4">
      <Link to="/dashboard" className="text-sm text-text-muted hover:text-text-primary transition-colors">
        &larr; Dashboard
      </Link>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {artistName ? (
          <h1 className="font-display text-3xl font-extrabold text-text-primary">{artistName}</h1>
        ) : (
          <div className="h-9 w-48 rounded bg-bg-secondary animate-pulse" aria-hidden="true" />
        )}
        <Link to={`/a/${slug}`} className="text-sm text-accent-primary hover:underline">
          View live profile
        </Link>
      </div>
      <nav aria-label="Artist settings" className="flex gap-1 border-b border-border overflow-x-auto">
        {tabs.map(tab => (
          <Link
            key={tab.id}
            to={`/artist-edit/${slug}${tab.path}`}
            aria-current={tab.id === active ? 'page' : undefined}
            className={`inline-flex items-center min-h-11 px-2 sm:px-3 -mb-px border-b-2 text-sm whitespace-nowrap transition-colors ${
              tab.id === active
                ? 'border-accent-primary text-text-primary font-medium'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
