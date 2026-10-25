import { useState, useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { UsernameField } from '../components/UsernameField';
import { LocationField } from '../components/LocationField';
import { PasswordChangeForm } from '../components/PasswordChangeForm';
import { EmailChangeForm } from '../components/EmailChangeForm';
import { refreshSessionAfterEmailChange } from '../services/auth';
import { SharingControls } from '../components/SharingControls';
import { NewsletterPrompt } from '../components/NewsletterPrompt';
import { ReleaseFeedOffSwitch } from '../components/ReleaseFeedOffSwitch';
import { NotificationPreferences } from '../components/NotificationPreferences';
import { BandcampConnect } from '../components/BandcampConnect';
import { PageSkeleton } from '../components/PageSkeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { RATE_LIMIT_MESSAGE } from '../utils/rateLimit';

interface Settings {
  username: string | null;
  location: string | null;
  email: string;
  hasPassword: boolean;
  pendingEmailChange?: string | null;
}

export function SettingsPage() {
  const { session, isLoading: authLoading } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry. A failed load leaves `settings` null, and the sections built from it are
  // replaced by a retry rather than rendered from defaults: an empty username field, no email,
  // and "Set password" for someone who has one all read as facts about the account.
  const [attempt, setAttempt] = useState(0);
  // Set when a new pending change starts or one is cancelled, so the banner tracks the
  // server without a refetch; the first load seeds it from the settings payload.
  const [pendingEmailChange, setPendingEmailChange] = useState<string | null>(null);
  // ?confirm_email=<token> arrives from the link in the confirmation email. The confirm
  // POST runs during load; the outcome renders as the banner below. The initial banner state
  // derives from this param, so any visit that arrives without the param starts with no
  // banner — and the param is cleared from the router once this load has handled it.
  const [searchParams, setSearchParams] = useSearchParams();
  const confirmToken = searchParams.get('confirm_email');
  const [confirmStatus, setConfirmStatus] = useState<'working' | 'success' | 'error' | null>(
    confirmToken ? 'working' : null,
  );
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!session) return;

    async function loadSettings() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/me/settings', {
          headers: { 'Authorization': `Bearer ${session!.access_token}` },
        });

        if (response.status === 429) {
          setError(RATE_LIMIT_MESSAGE);
        } else if (!response.ok) {
          throw new Error('Failed to load settings');
        } else {
          const data: Settings = await response.json();
          setSettings(data);
          setPendingEmailChange(data.pendingEmailChange ?? null);
        }
      } catch (e) {
        Sentry.captureException(e, { extra: { context: 'settings.loadSettings' } });
        setError('Failed to load settings. Please try again.');
      }
      setLoading(false);
    }
    loadSettings();
  }, [session, authLoading, attempt]);

  // Applying a confirmation link: POST the token, then drop it from the URL so a reload
  // or a shared link can't replay a used token — the banner below shows the outcome.
  useEffect(() => {
    if (authLoading || !session || !confirmToken) return;

    async function confirmChange() {
      try {
        const response = await fetch('/api/me/email/confirm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session!.access_token}`,
          },
          body: JSON.stringify({ token: confirmToken }),
        });
        const data = await response.json().catch(() => ({}));

        if (response.ok) {
          setConfirmStatus('success');
          setConfirmMessage(`Your email is now ${data.email || 'updated'}. Sign-in and notification emails go to the new address.`);
          setPendingEmailChange(null);
          // Seed the new address straight away: the settings GET fired on mount may have
          // returned the pre-change address, and both "Signed in as" and the form's
          // duplicate check read settings.email. The session refresh below re-runs the
          // settings load, which keeps this honest (fix list item 4 on UNS-212).
          if (typeof data.email === 'string' && data.email) {
            setSettings((prev) => (prev ? { ...prev, email: data.email } : prev));
          }
          // Pick up a re-issued session so the JWT's email claim matches immediately. Best
          // effort: the held token stays valid until it expires, and AuthContext refreshes
          // it on the next authenticated call regardless.
          refreshSessionAfterEmailChange().then(refreshError => {
            if (refreshError && refreshError.error && refreshError.error !== 'Auth not configured') {
              Sentry.captureMessage(`Email-change session refresh failed: ${refreshError.error}`, {
                level: 'warning',
                tags: { context: 'settings.confirmEmailChange' },
              });
            }
          });
        } else if (response.status === 429) {
          setConfirmStatus('error');
          setConfirmMessage(RATE_LIMIT_MESSAGE);
        } else {
          setConfirmStatus('error');
          setConfirmMessage(data.error || 'We could not confirm that email change. Start a new one below.');
        }
      } catch (e) {
        Sentry.captureException(e, { extra: { context: 'settings.confirmEmailChange' } });
        setConfirmStatus('error');
        setConfirmMessage('Network error while confirming. Try the link again.');
      }
      // Drop the token from the URL — through the router, not history.replaceState, so the
      // router's location forgets it too. Otherwise a remount that still carries the used
      // token re-runs this POST and re-shows a stale (and now failing) banner (fix list
      // item 5 on UNS-212). With no token left the effect above returns early, so the burned
      // token is never posted twice; the outcome banner already holds this render's result.
      setSearchParams({}, { replace: true });
    }
    confirmChange();
  }, [session, authLoading, confirmToken, setSearchParams]);

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

          {/* Email-change confirmation outcome. Shown for the visit the link opened; the
              Email section below is where the pending/new state lives afterwards. */}
          {confirmStatus !== null && (
            <div
              role="status"
              className={
                confirmStatus === 'success'
                  ? 'p-4 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm'
                  : confirmStatus === 'error'
                    ? 'p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm'
                    : 'p-4 rounded-lg bg-bg-secondary border border-border text-text-muted text-sm'
              }
            >
              {confirmStatus === 'working' ? 'Confirming your email change…' : confirmMessage}
            </div>
          )}

          {!settings && (
            <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-3">
              <h2 className="text-lg font-semibold">Profile, email and password</h2>
              <p className="text-sm text-text-muted">
                These couldn't be loaded, so they're hidden rather than shown blank.
              </p>
              <button
                type="button"
                onClick={() => setAttempt(n => n + 1)}
                className="text-sm font-medium text-text-primary underline hover:no-underline"
              >
                Try again
              </button>
            </section>
          )}

          {/* Profile section */}
          {settings && (
          <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Profile</h2>
            <UsernameField
              currentUsername={settings.username}
              accessToken={session!.access_token}
              onSaved={(username) => setSettings(prev => prev ? { ...prev, username } : prev)}
            />
            <LocationField
              currentLocation={settings.location}
              accessToken={session!.access_token}
              onSaved={(location) => setSettings(prev => prev ? { ...prev, location } : prev)}
            />
          </section>
          )}

          {/* Public profile section */}
          <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Public profile</h2>
            <SharingControls />
          </section>

          {/* Bandcamp collection section */}
          <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Bandcamp collection</h2>
            <BandcampConnect />
          </section>

          {/* Revoking the private release feed, and nothing else about it — subscribing lives
              under Releases on /my-collection. A token outlives the saved artists that justified
              it, so the off switch can't sit behind the same gate; see the component's own note. */}
          <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Release feed</h2>
            <ReleaseFeedOffSwitch />
          </section>

          {/* The one-time Lightbulbs On invitation, which used to sit on the signed-in home. It
              lands directly above Notifications because both are "which emails do I get" — and
              because a dismissible banner at the top of this page would compete with the
              email-change confirmation banner above. Renders nothing once dismissed or signed up,
              and keeps the `unstream` source tag so the Buttondown cohort stays continuous. */}
          <NewsletterPrompt email={session?.user?.email} source="unstream" />

          {/* Notifications section. The id is the anchor every notification email's opt-out
              footer links to (see subscriptionFooter in api/functions/notifications.ts). */}
          <section id="notifications" className="scroll-mt-24 p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Notifications</h2>
            <p className="text-sm text-text-muted">
              Emails about the artists you've saved.
            </p>
            <NotificationPreferences />
          </section>

          {/* Email section (UNS-212). Sits directly above the password fields, per the
              issue. Pending-change display lives inside the form so it refreshes in place. */}
          {settings && (
          <section id="email-change" className="scroll-mt-24 p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Email</h2>
            <EmailChangeForm
              accessToken={session!.access_token}
              currentEmail={settings.email}
              pendingEmail={pendingEmailChange}
              onPendingChange={setPendingEmailChange}
            />
          </section>
          )}

          {/* Password section */}
          {settings && (
          <section className="p-6 rounded-lg bg-bg-secondary border border-border space-y-4">
            <h2 className="text-lg font-semibold">Password</h2>
            <PasswordChangeForm
              accessToken={session!.access_token}
              hasPassword={settings.hasPassword}
            />
          </section>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
