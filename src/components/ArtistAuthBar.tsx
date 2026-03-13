import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getSession, signOut } from '../services/auth';

export function ArtistAuthBar() {
  const navigate = useNavigate();
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    getSession().then(session => {
      if (session) setLoggedIn(true);
    });
  }, []);

  if (!loggedIn) return null;

  async function handleSignOut() {
    await signOut();
    setLoggedIn(false);
    navigate('/artist-login');
  }

  return (
    <div className="bg-bg-secondary border-b border-border px-4 py-2 flex items-center justify-between text-sm">
      <div className="flex items-center gap-3">
        <span className="text-text-muted">Artist account</span>
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
