import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export type NavItem = {
  to: string;
  label: string;
  /** Accent-coloured, for primary destinations (Dashboard, admin alerts). */
  emphasis?: boolean;
};

/**
 * Hamburger menu that houses the header nav on small screens. The desktop
 * header renders the same items inline, so this is hidden from `sm` up.
 */
export function MobileNav({
  items,
  email,
  onSignOut,
}: {
  items: NavItem[];
  email?: string;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function handlePointerDown(event: Event) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative sm:hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="-mr-2 p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-nav"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          {open ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
      </button>

      {open && (
        <nav
          id="mobile-nav"
          aria-label="Main menu"
          className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-bg-card shadow-lg"
        >
          {email && (
            <p className="truncate border-b border-border px-4 py-2 text-xs text-text-muted">
              {email}
            </p>
          )}
          {items.map(item => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={`block px-4 py-3 text-sm hover:bg-bg-hover transition-colors ${
                item.emphasis ? 'text-accent-primary font-medium' : 'text-text-primary'
              }`}
            >
              {item.label}
            </Link>
          ))}
          {onSignOut && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
              className="block w-full px-4 py-3 text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              Sign out
            </button>
          )}
        </nav>
      )}
    </div>
  );
}
