import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';

export function Header() {
  const { preference, cycleTheme } = useTheme();
  const navigate = useNavigate();
  const { session, user, isAdmin, isLoading, signOut } = useAuth();
  const [pendingVerifyCount, setPendingVerifyCount] = useState(0);

  // Fetch pending verification count for admins
  useEffect(() => {
    if (!isAdmin || !session?.access_token) return;

    fetch('/api/admin/verify', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.requests) {
          const pending = data.requests.filter((r: { status: string }) => r.status === 'pending').length;
          setPendingVerifyCount(pending);
        }
      })
      .catch(() => { /* silent */ });
  }, [isAdmin, session?.access_token]);

  async function handleSignOut() {
    await signOut();
    navigate('/artist-login');
  }

  return (
    <header className="p-4 border-b border-border flex items-center justify-between gap-4">
      <Link to="/" className="text-xl font-bold text-text-primary hover:opacity-80 transition-opacity shrink-0">
        Unstream
      </Link>
      <div className="flex items-center gap-3 text-sm">
        {!isLoading && (
          session ? (
            <>
              <span className="text-text-muted hidden sm:inline">
                {user?.email}
              </span>
              {isAdmin && pendingVerifyCount > 0 && (
                <Link
                  to="/admin/verify"
                  className="text-accent-primary hover:underline font-medium"
                >
                  Verify ({pendingVerifyCount})
                </Link>
              )}
              <Link
                to="/artist-dashboard"
                className="text-accent-primary hover:underline font-medium"
              >
                Dashboard
              </Link>
              <button
                onClick={handleSignOut}
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                Sign out
              </button>
            </>
          ) : (
            <Link
              to="/artist-login"
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              Artist login
            </Link>
          )
        )}
        <ThemeToggle preference={preference} onCycle={cycleTheme} />
      </div>
    </header>
  );
}
