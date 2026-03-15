import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getSession, getSupabaseClient, signOut } from '../services/auth';

export function ArtistAuthBar() {
  const navigate = useNavigate();
  const [loggedIn, setLoggedIn] = useState(false);
  const [email, setEmail] = useState('');

  useEffect(() => {
    async function check() {
      const session = await getSession();
      if (session) {
        setLoggedIn(true);
        // Get email from Supabase user
        const supabase = getSupabaseClient();
        if (supabase) {
          const { data } = await supabase.auth.getUser();
          if (data.user?.email) setEmail(data.user.email);
        }
      }
    }
    check();
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
        <span className="text-text-muted">
          Logged in as <strong className="text-text-primary">{email}</strong>
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
