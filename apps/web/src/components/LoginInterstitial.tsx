import { useId, useState } from 'react';
import * as Sentry from '@sentry/react';
import { useAuth } from '../contexts/AuthContext';
import { LegalConsent } from './LegalConsent';
import { Dialog } from './Dialog';
import { writePendingSave, clearPendingSave } from '../services/pendingSave';

interface LoginInterstitialProps {
  /**
   * The key to save under once signed in — the caller's own save key, exactly as its direct
   * save path uses it (ResultCard's `saveKey`), so a save resumed after sign-in can't land on a
   * different identifier than one made while signed in.
   */
  artistId: string;
  artistName?: string;
  artistImageUrl?: string;
  onClose: () => void;
}

export function LoginInterstitial({ artistId, artistName, artistImageUrl, onClose }: LoginInterstitialProps) {
  const { signInWithMagicLink, signInWithPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const titleId = useId();

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError('Enter your email');
      return;
    }
    setLoading(true);
    setError('');
    try {
      writePendingSave({ artistId, artistName, artistImageUrl });
      await signInWithMagicLink(email.trim());
      setMagicSent(true);
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.magicLinkInterstitial' } });
      setError('Failed to send magic link. Try again.');
      clearPendingSave();
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordLogin(e: React.FormEvent, close: () => void) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter email and password');
      return;
    }
    setLoading(true);
    setError('');
    try {
      writePendingSave({ artistId, artistName, artistImageUrl });
      await signInWithPassword(email.trim(), password);
      close(); // AuthContext will pick up the pending save
    } catch (e) {
      Sentry.captureException(e, { extra: { context: 'auth.passwordInterstitial' } });
      setError('Invalid email or password');
      clearPendingSave();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog labelledBy={titleId} onClose={onClose}>
      {close => (
      <div className="p-6">
        {magicSent ? (
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-accent-secondary/10 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-accent-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 id={titleId} className="font-semibold text-text-primary mb-2">Check your email</h3>
            <p className="text-sm text-text-secondary mb-4">
              We sent a login link to <span className="font-medium text-text-primary">{email}</span>. Click it to sign in and save {artistName || 'this artist'}.
            </p>
            <button
              onClick={close}
              className="text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <h3 id={titleId} className="font-semibold text-text-primary mb-1">Sign up or log in to save this artist</h3>
            <p className="text-sm text-text-secondary mb-4">
              With Unstream, keep track of artists you want to support, get new release alerts, and more.
            </p>

            {error && (
              <p className="text-sm text-error mb-3">{error}</p>
            )}

            {!showPassword ? (
              <form onSubmit={handleMagicLink} className="space-y-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2 px-4 rounded-lg bg-accent-primary text-accent-foreground font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {loading ? 'Sending...' : 'Send login link'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPassword(true)}
                  className="w-full py-2 px-4 text-sm text-text-muted hover:text-text-primary transition-colors"
                >
                  Sign in with password instead
                </button>
              </form>
            ) : (
              <form onSubmit={e => handlePasswordLogin(e, close)} className="space-y-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
                  autoFocus
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/50"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2 px-4 rounded-lg bg-accent-primary text-accent-foreground font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {loading ? 'Signing in...' : 'Sign in'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPassword(false)}
                  className="w-full py-2 px-4 text-sm text-text-muted hover:text-text-primary transition-colors"
                >
                  Use magic link instead
                </button>
              </form>
            )}

            <div className="mt-3">
              <LegalConsent />
            </div>

            <button
              onClick={close}
              className="w-full mt-3 py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      )}
    </Dialog>
  );
}