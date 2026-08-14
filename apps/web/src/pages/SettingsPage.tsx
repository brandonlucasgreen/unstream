import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { UsernameField } from '../components/UsernameField';
import { LocationField } from '../components/LocationField';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { SharingControls } from '../components/SharingControls';
import { ReleaseFeedControls } from '../components/ReleaseFeedControls';
import { NotificationPreferences } from '../components/NotificationPreferences';
import { BandcampConnect } from '../components/BandcampConnect';
import { PageSkeleton } from '../components/PageSkeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';

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

        if (!response.ok) {
          throw new Error('Failed to load settings');
        }

        const data = await response.json();
        setSettings(data);
      } catch (e) {
        Sentry.captureException(e, { extra: { context: 'settings.loadSettings' } });
        setError('Failed to load settings. Please try again.');
      }
      setLoading(false);
    }
    loadSettings();
  }, [session, authLoading]);

  if (!authLoading && !session) {
    return <Navigate to="/login" replace />;
  }

  if (authLoading || loading) {
    return (
      <PageSkeleton label="Loading your settings">
        <FormSkeleton sections={3} />
      </PageSkeleton>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-8">
          <h1 className="text-2xl font-bold">Settings</h1>

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

          {/* Sharing section */}
          <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Sharing</h2>
            <SharingControls />
          </section>

          {/* Bandcamp collection section */}
          <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Bandcamp collection</h2>
            <BandcampConnect />
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
        </div>
      </main>

      <Footer />
    </div>
  );
}
