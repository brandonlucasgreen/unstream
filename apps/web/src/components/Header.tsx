import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MobileNav, isNavGroup, type NavEntry, type NavGroup } from './MobileNav';
import { NavDropdown } from './NavDropdown';
import { HeaderSearch } from './HeaderSearch';
import { useAuth } from '../contexts/AuthContext';

function UnstreamLogo() {
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
      <path d="M14,52 A41,41 0 0,1 96,52" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
      <line x1="14" y1="52" x2="14" y2="64" stroke="currentColor" strokeWidth="7" strokeLinecap="round"/>
      <line x1="96" y1="52" x2="96" y2="64" stroke="currentColor" strokeWidth="7" strokeLinecap="round"/>
      <rect x="3" y="60" width="22" height="28" rx="9" fill="currentColor"/>
      <rect x="85" y="60" width="22" height="28" rx="9" fill="currentColor"/>
    </svg>
  );
}

export function Header() {
  const navigate = useNavigate();
  const { session, user, isAdmin, signOut } = useAuth();
  const [pendingVerifyCount, setPendingVerifyCount] = useState(0);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  // Fetch pending verification count for admins — only on admin-relevant pages
  useEffect(() => {
    if (!isAdmin || !session?.access_token) return;
    const controller = new AbortController();
    fetch('/api/admin/verify', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
      signal: controller.signal,
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.requests) {
          const pending = data.requests.filter((r: { status: string }) => r.status === 'pending').length;
          setPendingVerifyCount(pending);
        }
      })
      .catch(() => { /* aborted or network error */ });
    return () => controller.abort();
  }, [isAdmin, session?.access_token]);

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  // Every admin destination in one group rather than a growing row of top-level
  // items. /admin/merge is deliberately absent: it acts on results selected on a
  // search page and has nothing to show when opened directly.
  //
  // The group carries the pending-verification emphasis so a queue waiting for
  // review is still visible without opening the menu.
  const adminGroup: NavGroup = {
    label: 'Admin',
    emphasis: pendingVerifyCount > 0,
    items: [
      {
        to: '/admin/verify',
        label: pendingVerifyCount > 0 ? `Verify (${pendingVerifyCount})` : 'Verify',
        emphasis: pendingVerifyCount > 0,
      },
      { to: '/admin/links', label: 'Removed links' },
      { to: '/admin/analytics', label: 'Analytics' },
    ],
  };

  // Shared by the inline desktop nav and the mobile hamburger menu, so new
  // items only need adding in one place.
  const navItems: NavEntry[] = session
    ? [
        ...(isAdmin ? [adminGroup] : []),
        { to: '/dashboard', label: 'Dashboard', emphasis: true },
        { to: '/settings', label: 'Settings' },
      ]
    : [{ to: '/login', label: 'Login' }];

  // The sticky header keeps a solid background rather than a blurred one: a
  // backdrop-filter would become the containing block for MobileNav's fixed
  // overlay and trap the drawer inside the header instead of covering the page.
  // For the same reason, don't add a transform or filter to this element.
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg-primary">
      <div className="relative p-4 flex items-center gap-4">
        <Link to="/" className="text-xl font-bold text-text-primary hover:opacity-80 transition-opacity shrink-0 flex items-center gap-2">
          <UnstreamLogo />
          Unstream
        </Link>

        {/* Search is available from every page, not just the homepage.
            Positioned absolutely rather than as a flex child so it sits at the
            true centre of the header. As a flex child it was only centred within
            whatever space the sides left over, so a signed-in admin's longer nav
            pushed it visibly left of centre while a logged-out visitor's did not.
            The transform is scoped to this wrapper and must NOT be moved onto
            <header>: a transform there would become the containing block for
            MobileNav's fixed overlay, trapping the drawer inside the header.
            Inline from lg only — below that the nav takes so much of the row that
            a centred bar could only be ~140px wide, so the magnifier opens the
            same component as a full-width second row instead. */}
        <div className="hidden lg:block absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm xl:max-w-md px-4">
          <HeaderSearch />
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={() => setMobileSearchOpen(open => !open)}
            className="lg:hidden p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
            aria-label="Search artists"
            aria-expanded={mobileSearchOpen}
            aria-controls="header-search-row"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>

          {/* No email here. It's the widest and least predictable thing on this
              side (an address can be 15 or 40 characters), which is exactly what
              made a centred bar collide at laptop widths. It's still in the
              mobile drawer and on /settings. */}
          <nav className="hidden sm:flex items-center gap-3 text-sm">
            {navItems.map(entry => isNavGroup(entry) ? (
              <NavDropdown key={entry.label} group={entry} />
            ) : (
              <Link
                key={entry.to}
                to={entry.to}
                className={entry.emphasis
                  ? 'text-accent-primary hover:underline font-medium'
                  : 'text-text-muted hover:text-text-primary transition-colors'}
              >
                {entry.label}
              </Link>
            ))}
            {session && (
              <button
                onClick={handleSignOut}
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                Sign out
              </button>
            )}
          </nav>

          <MobileNav
            items={navItems}
            email={session ? user?.email : undefined}
            onSignOut={session ? handleSignOut : undefined}
          />
        </div>
      </div>

      {mobileSearchOpen && (
        <div id="header-search-row" className="lg:hidden px-4 pb-4">
          <HeaderSearch autoFocus onClose={() => setMobileSearchOpen(false)} />
        </div>
      )}
    </header>
  );
}
