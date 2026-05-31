import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../contexts/AuthContext';

function UnstreamLogo({ dark }: { dark: boolean }) {
  const color = dark ? 'white' : '#1a1a1a';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 110 110"
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <filter id="gs"><feColorMatrix type="saturate" values="0"/></filter>
      </defs>
      <g transform="translate(22,22) scale(1.8333)" filter="url(#gs)">
        <path fill="#50A5E6" d="M30 22c-3 0-6.688 7.094-7 10-.421 3.915 2 4 2 4h11V26s-3.438-4-6-4z"/>
        <ellipse transform="rotate(-60 27.574 28.49)" fill="#1C6399" cx="27.574" cy="28.489" rx="5.848" ry="1.638"/>
        <path fill="#F9CA55" d="M20.086 0c1.181 0 2.138.957 2.138 2.138 0 .789.668 10.824.668 10.824L17.948 18V2.138C17.948.957 18.905 0 20.086 0z"/>
        <path fill="#FFDC5D" d="M18.875 4.323c0-1.099.852-1.989 1.903-1.989 1.051 0 1.903.891 1.903 1.989 0 0 .535 5.942 1.192 9.37.878 1.866 1.369 4.682 1.261 6.248.054.398 5.625 5.006 5.625 5.006-.281 1.813-2.259 6.155-4.759 8.159l-3.521-2.924c-2.885-.404-4.458-3.331-4.458-4.264 0-2.984.854-21.595.854-21.595z"/>
        <path fill="#50A5E6" d="M6 22c3 0 6.688 7.094 7 10 .421 3.915-2 4-2 4H0V26s3.438-4 6-4z"/>
        <ellipse transform="rotate(-30 8.424 28.489)" fill="#1C6399" cx="8.426" cy="28.489" rx="1.638" ry="5.848"/>
        <path fill="#F9CA55" d="M16.061.011c-1.266-.127-2.333.864-2.333 2.103 0 .78-.184 10.319-.184 10.319L17.895 18l.062-15.765c0-1.106-.795-2.114-1.896-2.224z"/>
        <path fill="#FFDC5D" d="M17.125 4.323c0-1.099-.852-1.989-1.903-1.989-1.051 0-1.903.891-1.903 1.989 0 0-.535 5.942-1.192 9.37-.878 1.866-1.369 4.682-1.261 6.248-.054.398-5.625 5.006-5.625 5.006C5.522 26.76 7.5 31.102 10 33.106l3.521-2.924c2.885-.404 4.458-3.331 4.458-4.264 0-2.984-.854-21.595-.854-21.595z"/>
        <path fill="#F9CA55" d="M17.958 25.823c-.414 0-.75-.336-.75-.75V2.792c0-.414.336-.75.75-.75s.75.336.75.75v22.282c.001.413-.335.749-.75.749z"/>
      </g>
      <path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"/>
      <line x1="14" y1="52" x2="14" y2="64" stroke={color} strokeWidth="7" strokeLinecap="round"/>
      <line x1="96" y1="52" x2="96" y2="64" stroke={color} strokeWidth="7" strokeLinecap="round"/>
      <rect x="3" y="60" width="22" height="28" rx="9" fill={color}/>
      <rect x="85" y="60" width="22" height="28" rx="9" fill={color}/>
    </svg>
  );
}

export function Header() {
  const { theme, preference, cycleTheme } = useTheme();
  const navigate = useNavigate();
  const { session, user, isAdmin, signOut } = useAuth();
  const [pendingVerifyCount, setPendingVerifyCount] = useState(0);

  // Fetch pending verification count for admins — only on admin-relevant pages
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
    navigate('/login');
  }

  return (
    <header className="p-4 border-b border-border flex items-center justify-between gap-4">
      <Link to="/" className="text-xl font-bold text-text-primary hover:opacity-80 transition-opacity shrink-0 flex items-center gap-2">
        <UnstreamLogo dark={theme === 'dark'} />
        Unstream
      </Link>
      <div className="flex items-center gap-3 text-sm">
        {session ? (
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
              to="/dashboard"
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
            to="/login"
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            Login
          </Link>
        )}
        <ThemeToggle preference={preference} onCycle={cycleTheme} />
      </div>
    </header>
  );
}
