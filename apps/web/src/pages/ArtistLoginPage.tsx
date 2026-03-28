import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signInWithMagicLink, signInWithPassword, resetPasswordForEmail } from '../services/auth';
import { useAuth } from '../contexts/AuthContext';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

type ViewMode = 'form' | 'magicLinkSent' | 'resetSent';

export function ArtistLoginPage() {
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewMode>('form');

  useEffect(() => {
    if (!authLoading && session) {
      navigate('/artist-dashboard', { replace: true });
    }
  }, [session, authLoading, navigate]);

  async function checkAccount(): Promise<boolean> {
    const checkResponse = await fetch('/api/artist-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() }),
    });

    if (!checkResponse.ok) {
      const errData = await checkResponse.json().catch(() => ({}));
      setError(errData.error || 'Something went wrong. Please try again.');
      return false;
    }

    const checkData = await checkResponse.json();
    if (!checkData.hasAccount) {
      setError('No claimed artist profiles found for this email. You can claim your artist page from any artist profile on Unstream.');
      return false;
    }

    return true;
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (!(await checkAccount())) {
        setLoading(false);
        return;
      }

      const { error: authError } = await signInWithPassword(email.trim(), password);
      if (authError) {
        setError(authError);
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleSendMagicLink() {
    setError(null);
    setLoading(true);

    try {
      if (!(await checkAccount())) {
        setLoading(false);
        return;
      }

      const redirectTo = `${window.location.origin}/artist-login`;
      const { error: authError } = await signInWithMagicLink(email.trim(), redirectTo);

      if (authError) {
        setError(authError);
      } else {
        setView('magicLinkSent');
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      setError('Enter your email address first.');
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
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold">Artist Login</h1>
            <p className="text-text-muted text-sm">
              Sign in to manage your claimed artist profiles on Unstream.
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {view === 'form' && (
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
                Don't have a password yet? Use the sign-in link, then set one from your dashboard.
              </p>
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

          <p className="text-center text-xs text-text-muted">
            Don't have an account?{' '}
            <Link to="/" className="text-accent-primary hover:underline">
              Search for your artist page
            </Link>{' '}
            and claim it to get started.
          </p>
        </div>
      </main>

      <Footer />
    </div>
  );
}
