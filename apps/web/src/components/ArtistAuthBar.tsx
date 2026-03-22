import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function ArtistAuthBar() {
  const navigate = useNavigate();
  const { session, user, isLoading, signOut } = useAuth();

  // Reserve space during loading to prevent CLS
  if (isLoading) {
    return <div className="h-[41px] bg-bg-secondary border-b border-border" />;
  }

  if (!session) return null;

  async function handleSignOut() {
    await signOut();
    navigate('/artist-login');
  }

  return (
    <div className="bg-bg-secondary border-b border-border px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-3">
        <span className="text-text-muted">
          Logged in as <strong className="text-text-primary">{user?.email}</strong>
        </span>
        <Link
          to="/artist-dashboard"
          className="text-accent-primary hover:underline font-medium"
        >
          Dashboard
        </Link>
      </div>
      <button
        onClick={handleSignOut}
        className="text-text-muted hover:text-text-primary transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
