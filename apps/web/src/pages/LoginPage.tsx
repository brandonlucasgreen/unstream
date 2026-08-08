import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { signInWithMagicLink, signInWithPassword, resetPasswordForEmail } from '../services/auth';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';
import { PageSkeleton } from '../components/PageSkeleton';
import { FormSkeleton } from '../components/LoadingSkeletons';
import { LegalConsent } from '../components/LegalConsent';

type ViewMode = 'form' | 'magicLinkSent' | 'resetSent';

export function LoginPage() {
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewMode>('form');

  useEffect(() => {
    if (!authLoading && session) {
      navigate('/dashboard', { replace: true });
    }
  }, [session, authLoading, navigate]);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { error: authError } = await signInWithPassword(email.trim(), password);
      if (authError) {
        setError(authError);
      }
      setLoading(false);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.passwordLogin' } });
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  async function handleSendMagicLink() {
    setError(null);
    setLoading(true);

    try {
      const redirectTo = `${window.location.origin}/login`;
      const { error: authError } = await signInWithMagicLink(email.trim(), redirectTo);

      if (authError) {
        setError(authError);
      } else {
        setView('magicLinkSent');
      }
      setLoading(false);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.magicLink' } });
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      setError('Enter your email address first.');
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error: resetError } = await resetPasswordForEmail(email.trim(), redirectTo);

      if (resetError) {
        setError(resetError);
      } else {
        setView('resetSent');
      }
      setLoading(false);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.resetPassword' } });
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  if (authLoading) {
    return (
      <PageSkeleton label="Loading sign in" maxWidth="max-w-md">
        <FormSkeleton sections={1} fields={2} />
      </PageSkeleton>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold">Login</h1>
            <p className="text-text-muted text-sm">
              Sign in to manage your claimed artist profiles and saved artists on Unstream.
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {view === 'form' && (
            <>
              {session ? (
                <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
                  <p className="font-medium">Signed in as <strong className="text-text-primary">{session.user.email}</strong></p>
                  <button
                    type="button"
                    onClick={() => navigate('/dashboard')}
                    className="text-sm text-accent-primary hover:underline"
                  >
                    Go to Dashboard
                  </button>
                </div>
              ) : (
                <>
                  <form onSubmit={handlePasswordSubmit} className="space-y-4">
                    <div>
                      <label htmlFor="email" className="block text-sm font-medium mb-1">
                        Email address
                      </label>
                      <input
                        id="email"
                        type="email"
                        required
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="artist@example.com"
                        className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
                      />
                    </div>
                    <div>
                      <label htmlFor="password" className="block text-sm font-medium mb-1">
                        Password
                      </label>
                      <input
                        id="password"
                        type="password"
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="Enter your password"
                        className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
                      />
                      <div className="flex justify-end mt-1">
                        <button
                          type="button"
                          onClick={handleForgotPassword}
                          disabled={loading}
                          className="text-xs text-accent-primary hover:underline"
                        >
                          Forgot password?
                        </button>
                      </div>
                    </div>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
                    >
                      {loading ? 'Signing in...' : 'Sign in'}
                    </button>
                  </form>

                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-bg-primary px-2 text-text-muted">or</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleSendMagicLink}
                    disabled={loading || !email.trim()}
                    className="w-full py-2 rounded-lg border border-border text-text-primary font-medium hover:bg-bg-secondary transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Sending...' : 'Send sign-in link to email'}
                  </button>

                  <p className="text-center text-xs text-text-muted">
                    Don't have an account yet? <a href="https://unstream.stream" className="text-accent-primary hover:underline">Search for an artist</a> you like and click Save.
                  </p>

                  <LegalConsent />
                </>
              )}
            </>
          )}

          {view === 'magicLinkSent' && (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
              <p className="font-medium">Check your email</p>
              <p className="text-sm text-text-muted">
                We sent a sign-in link to <strong className="text-text-primary">{email}</strong>.
                Click the link to access your dashboard.
              </p>
              <button
                type="button"
                onClick={() => { setView('form'); setError(null); }}
                className="text-sm text-accent-primary hover:underline"
              >
                Back to sign in
              </button>
            </div>
          )}

          {view === 'resetSent' && (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
              <p className="font-medium">Check your email</p>
              <p className="text-sm text-text-muted">
                We sent a password reset link to <strong className="text-text-primary">{email}</strong>.
                Click the link to set a new password.
              </p>
              <button
                type="button"
                onClick={() => { setView('form'); setError(null); }}
                className="text-sm text-accent-primary hover:underline"
              >
                Back to sign in
              </button>
            </div>
          )}

          <div className="text-center space-y-2">
            <p className="text-xs text-text-muted">
              Artists: Click the "Claim" button on your listing to customize your links, fix inaccuracies, and more.
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
