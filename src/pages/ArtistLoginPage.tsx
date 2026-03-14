import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signInWithMagicLink, getSession, waitForMagicLinkSession } from '../services/auth';
import { ThemeToggle } from '../components/ThemeToggle';
import { ArtistAuthBar } from '../components/ArtistAuthBar';
import { Footer } from '../components/Footer';
import { useTheme } from '../hooks/useTheme';

export function ArtistLoginPage() {
  const { preference, cycleTheme } = useTheme();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [emailSent, setEmailSent] = useState(false);

  // If already authenticated, redirect to dashboard
  useEffect(() => {
    async function checkAuth() {
      // Handle magic link callback hash
      if (window.location.hash.includes('access_token')) {
        const { session, error: authError } = await waitForMagicLinkSession();
        if (session) {
          // Clear the hash to avoid re-processing on refresh
          window.history.replaceState(null, '', window.location.pathname);
          navigate('/artist-dashboard', { replace: true });
          return;
        }
        if (authError) {
          setError(authError);
          // Clear the hash so the user doesn't keep hitting the expired token
          window.history.replaceState(null, '', window.location.pathname);
        }
        setCheckingSession(false);
        return;
      }

      const session = await getSession();
      if (session) {
        navigate('/artist-dashboard', { replace: true });
        return;
      }
      setCheckingSession(false);
    }
    checkAuth();
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Check if this email has any verified claims
      const checkResponse = await fetch('/api/artist-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (!checkResponse.ok) {
        const errData = await checkResponse.json().catch(() => ({}));
        setError(errData.error || 'Something went wrong. Please try again.');
        setLoading(false);
        return;
      }

      const checkData = await checkResponse.json();
      if (!checkData.hasAccount) {
        setError('No claimed artist profiles found for this email. You can claim your artist page from any artist profile on Unstream.');
        setLoading(false);
        return;
      }

      // Send magic link
      const redirectTo = `${window.location.origin}/artist-login`;
      const { error: authError } = await signInWithMagicLink(email.trim(), redirectTo);

      if (authError) {
        setError(authError);
      } else {
        setEmailSent(true);
      }
    } catch {
      setError('Network error. Please try again.');
    }
    setLoading(false);
  }

  if (checkingSession) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <ArtistAuthBar />
      <header className="p-4 border-b border-border flex items-center justify-between">
        <Link to="/" className="text-xl font-bold text-accent-primary hover:opacity-80 transition-opacity">
          Unstream
        </Link>
        <ThemeToggle preference={preference} onCycle={cycleTheme} />
      </header>

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

          {!emailSent ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium mb-1">
                  Your email address
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
                <p className="text-xs text-text-muted mt-1">
                  Use the same email you used to claim your artist profile.
                </p>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? 'Checking...' : 'Send sign-in link'}
              </button>
            </form>
          ) : (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
              <div className="text-3xl">📧</div>
              <p className="font-medium">Check your email</p>
              <p className="text-sm text-text-muted">
                We sent a sign-in link to <strong className="text-text-primary">{email}</strong>.
                Click the link to access your dashboard.
              </p>
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
