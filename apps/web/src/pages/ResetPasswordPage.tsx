import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { updatePassword } from '../services/auth';
import { useAuth } from '../contexts/AuthContext';
import { ThemeToggle } from '../components/ThemeToggle';
import { Footer } from '../components/Footer';
import { useTheme } from '../hooks/useTheme';

export function ResetPasswordPage() {
  const { preference, cycleTheme } = useTheme();
  const navigate = useNavigate();
  const { session, isLoading: authLoading } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await updatePassword(newPassword);
      if (updateError) {
        setError(updateError);
      } else {
        setSuccess(true);
        setTimeout(() => navigate('/artist-dashboard', { replace: true }), 2000);
      }
    } catch {
      setError('Something went wrong. Please try again.');
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

  const hasValidSession = !!session;

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <header className="p-4 border-b border-border flex items-center justify-between">
        <Link to="/" className="text-xl font-bold text-accent-primary hover:opacity-80 transition-opacity">
          Unstream
        </Link>
        <ThemeToggle preference={preference} onCycle={cycleTheme} />
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold">Reset Password</h1>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          {success ? (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
              <p className="font-medium">Password updated</p>
              <p className="text-sm text-text-muted">
                Redirecting to your dashboard...
              </p>
            </div>
          ) : hasValidSession ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium mb-1">
                  New password
                </label>
                <input
                  id="new-password"
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoFocus
                  className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium mb-1">
                  Confirm password
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter your password"
                  className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 rounded-lg bg-accent-primary text-white font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
              >
                {loading ? 'Updating...' : 'Set new password'}
              </button>
            </form>
          ) : (
            <div className="text-center space-y-4 p-6 rounded-lg bg-bg-secondary border border-border">
              <p className="font-medium">Invalid or expired link</p>
              <p className="text-sm text-text-muted">
                This password reset link is no longer valid. Please request a new one from the login page.
              </p>
              <Link
                to="/artist-login"
                className="inline-block text-sm text-accent-primary hover:underline"
              >
                Back to login
              </Link>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
