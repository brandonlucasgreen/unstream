import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { AccountLayout } from '../components/AccountLayout';
import { UsernameField } from '../components/UsernameField';
import { LocationField } from '../components/LocationField';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { SharingControls } from '../components/SharingControls';
import { ReleaseFeedControls } from '../components/ReleaseFeedControls';
import { NotificationPreferences } from '../components/NotificationPreferences';
import { SkeletonScreen } from '../components/Skeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

interface Settings {
  username: string | null;
  location: string | null;
  email: string;
  hasPassword: boolean;
}

export function SettingsPage() {
  const { session, isLoading: authLoading } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!session) return;

    async function loadSettings() {
      try {
        const response = await fetch('/api/me/settings', {
          headers: { 'Authorization': `Bearer ${session!.access_token}` },
        });

        if (response.status === 429) {
          setError(RATE_LIMIT_MESSAGE);
        } else if (!response.ok) {
          throw new Error('Failed to load settings');
        } else {
          setSettings(await response.json());
        }
      } catch (e) {
        Sentry.captureException(e, { extra: { context: 'settings.loadSettings' } });
        setError('Failed to load settings. Please try again.');
      }
      setLoading(false);
    }
    loadSettings();
  }, [session, authLoading]);

  if (authLoading || loading) {
    return (
      <AccountLayout title="Settings">
        <SkeletonScreen label="Loading your settings">
          <FormSkeleton sections={3} />
        </SkeletonScreen>
      </AccountLayout>
    );
  }

  return (
    <AccountLayout title="Settings">
      <div className="max-w-2xl space-y-8">
        {error && (
          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Profile section */}
        <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
          <h2 className="text-lg font-semibold">Profile</h2>
          <p className="text-sm text-text-muted">
            Signed in as <strong className="text-text-primary">{settings?.email}</strong>
          </p>
          <UsernameField
            currentUsername={settings?.username ?? null}
            accessToken={session!.access_token}
            onSaved={(username) => setSettings(prev => prev ? { ...prev, username } : prev)}
          />
          <LocationField
            currentLocation={settings?.location ?? null}
            accessToken={session!.access_token}
            onSaved={(location) => setSettings(prev => prev ? { ...prev, location } : prev)}
          />
        </section>

        {/* Public profile section */}
        <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
          <h2 className="text-lg font-semibold">Public profile</h2>
          <SharingControls />
        </section>

        {/* Release feed section */}
        <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
          <h2 className="text-lg font-semibold">Release calendar</h2>
          <ReleaseFeedControls />
        </section>

        {/* Notifications section. The id is the anchor every notification email's opt-out
            footer links to (see subscriptionFooter in api/functions/notifications.ts). */}
        <section id="notifications" className="scroll-mt-24 p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <p className="text-sm text-text-muted">
            Emails about the artists you've saved.
          </p>
          <NotificationPreferences />
        </section>

        {/* Password section */}
        <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
          <h2 className="text-lg font-semibold">Password</h2>
          {settings?.hasPassword ? (
            <PasswordChangeForm accessToken={session!.access_token} />
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-text-muted">
                Your account was created with a magic link. To set a password, use the password reset flow.
              </p>
              <a
                href="/login"
                className="inline-block text-sm text-accent-primary hover:underline"
              >
                Send password-setup email &rarr;
              </a>
            </div>
          )}
        </section>

        {/* Connecting Bandcamp moved to /collection, where the thing it fills in lives.
            People who learned the old location still come looking here. */}
        <p className="text-sm text-text-muted">
          Looking for your Bandcamp connection? It's on{' '}
          <Link to="/collection" className="text-accent-primary hover:underline">
            My Collection
          </Link>
          .
        </p>
      </div>
    </AccountLayout>
  );
}
