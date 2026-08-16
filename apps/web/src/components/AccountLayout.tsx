import { useEffect, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { Footer } from './Footer';
import { useAuth } from '../contexts/AuthContext';

/**
 * The shell every signed-in page renders inside: header, a sectioned account nav, the page.
 *
 * Two things it deliberately owns so the pages don't have to:
 *
 * - **The auth gate.** One redirect to /login here instead of the same three-branch dance
 *   copy-pasted into each page.
 * - **The claimed-artist list.** It's nav data now, so it's fetched once per session by
 *   AuthContext rather than per page. `loadClaimedProfiles` is a no-op after the first call.
 *
 * What it does *not* own is loading state for the page body. The nav is cheap and renders
 * immediately; each page shows its own skeleton for its own data. That's the whole point of
 * splitting the old dashboard up — no page should wait on another page's fetches.
 */
export function AccountLayout({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  /** One line under the heading, when the page needs to say what it is. */
  description?: string;
  /** Controls that belong beside the heading (e.g. a count, a filter). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { session, isLoading, claimedProfiles, loadClaimedProfiles } = useAuth();

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    loadClaimedProfiles(controller.signal);
    return () => controller.abort();
  }, [session, loadClaimedProfiles]);

  if (!isLoading && !session) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />

      <div className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 lg:flex lg:gap-10">
        <AccountNav profiles={claimedProfiles} />

        <main className="flex-1 min-w-0 mt-6 lg:mt-0">
          <div className="flex flex-wrap items-baseline justify-between gap-3 mb-6">
            <div>
              <h1 className="text-2xl font-bold">{title}</h1>
              {description && (
                <p className="text-sm text-text-muted mt-1">{description}</p>
              )}
            </div>
            {actions}
          </div>
          {children}
        </main>
      </div>

      <Footer />
    </div>
  );
}

interface NavLinkSpec {
  to: string;
  label: string;
  /** Also treat these paths as "you are here" (e.g. an artist's releases tab). */
  alsoActiveOn?: string[];
  /** Rendered indented, and only while the parent is active. */
  children?: { to: string; label: string }[];
}

interface NavSection {
  label?: string;
  items: NavLinkSpec[];
}

/**
 * Sidebar from `lg` up, a horizontally scrollable strip of pills below it.
 *
 * The strip is flat on purpose: at phone width a section heading costs a whole row and the
 * list is short enough to read without one. Sub-items still appear, because on the artist
 * pages they're the only way to reach the releases tab.
 */
function AccountNav({ profiles }: { profiles: { slug: string; name: string }[] }) {
  const { pathname } = useLocation();

  const sections: NavSection[] = [
    {
      items: [
        { to: '/dashboard', label: 'Dashboard' },
        { to: '/collection', label: 'My Collection' },
        { to: '/saved', label: 'Saved Artists' },
      ],
    },
    ...(profiles.length > 0
      ? [{
          label: 'Your artists',
          items: profiles.map(profile => ({
            to: `/artist-edit/${profile.slug}`,
            label: profile.name,
            alsoActiveOn: [`/artist-edit/${profile.slug}/releases`],
            children: [
              { to: `/artist-edit/${profile.slug}`, label: 'Profile' },
              { to: `/artist-edit/${profile.slug}/releases`, label: 'Releases' },
              { to: `/a/${profile.slug}`, label: 'Public page' },
            ],
          })),
        }]
      : []),
    { items: [{ to: '/settings', label: 'Settings' }] },
  ];

  const isActive = (item: NavLinkSpec) =>
    pathname === item.to || (item.alsoActiveOn?.includes(pathname) ?? false);

  return (
    <nav aria-label="Account" className="lg:w-56 lg:shrink-0">
      {/* Desktop: stacked sections */}
      <div className="hidden lg:block space-y-6 lg:sticky lg:top-24">
        {sections.map((section, i) => (
          <div key={section.label ?? i}>
            {section.label && (
              <p className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map(item => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    aria-current={isActive(item) ? 'page' : undefined}
                    className={`block px-3 py-2 rounded-lg text-sm truncate transition-colors ${
                      isActive(item)
                        ? 'bg-bg-secondary text-text-primary font-medium'
                        : 'text-text-muted hover:text-text-primary hover:bg-bg-secondary/60'
                    }`}
                  >
                    {item.label}
                  </Link>
                  {item.children && isActive(item) && (
                    <ul className="mt-0.5 ml-3 border-l border-border">
                      {item.children.map(child => (
                        <li key={child.to}>
                          <Link
                            to={child.to}
                            aria-current={pathname === child.to ? 'page' : undefined}
                            className={`block pl-4 pr-3 py-1.5 text-sm transition-colors ${
                              pathname === child.to
                                ? 'text-accent-primary font-medium'
                                : 'text-text-muted hover:text-text-primary'
                            }`}
                          >
                            {child.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Mobile / tablet: one scrollable row of pills */}
      <div className="lg:hidden -mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto">
        <ul className="flex items-center gap-2 w-max pb-1">
          {sections.flatMap(section => section.items).map(item => (
            <li key={item.to} className="contents">
              <Link
                to={item.to}
                aria-current={isActive(item) ? 'page' : undefined}
                className={`whitespace-nowrap px-3 py-1.5 rounded-full text-sm border transition-colors ${
                  isActive(item)
                    ? 'bg-bg-secondary border-border-hover text-text-primary font-medium'
                    : 'border-border text-text-muted hover:text-text-primary'
                }`}
              >
                {item.label}
              </Link>
              {item.children && isActive(item) && item.children.filter(c => c.to !== item.to).map(child => (
                <Link
                  key={child.to}
                  to={child.to}
                  aria-current={pathname === child.to ? 'page' : undefined}
                  className={`whitespace-nowrap px-3 py-1.5 rounded-full text-sm border transition-colors ${
                    pathname === child.to
                      ? 'bg-bg-secondary border-border-hover text-text-primary font-medium'
                      : 'border-border border-dashed text-text-muted hover:text-text-primary'
                  }`}
                >
                  {child.label}
                </Link>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
