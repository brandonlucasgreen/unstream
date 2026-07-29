import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export type NavItem = {
  to: string;
  label: string;
  /** Accent-coloured, for primary destinations (Dashboard, admin alerts). */
  emphasis?: boolean;
};

/** A labelled set of links — a dropdown on desktop, an indented block here. */
export type NavGroup = {
  label: string;
  items: NavItem[];
  /** Accent-coloured when something inside needs attention. */
  emphasis?: boolean;
};

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

/**
 * Full-height drawer that houses the header nav on small screens: a hamburger
 * in the header slides a panel in from the right over the page content. The
 * desktop header renders the same items inline, so all of this is hidden from
 * `sm` up.
 *
 * The drawer stays mounted and animates via transforms so it slides both open
 * and shut. `inert` keeps the closed panel out of the tab order and the
 * accessibility tree, which conditional rendering would otherwise handle.
 */
export function MobileNav({
  items,
  email,
  onSignOut,
}: {
  items: NavEntry[];
  email?: string;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    // Move focus into the drawer, and lock the page behind it so the content
    // doesn't scroll under the overlay.
    //
    // preventScroll is load-bearing: the panel is still transformed off-screen
    // when this runs, so a scrolling focus makes the browser scroll the clipped
    // overlay sideways to reveal the button. That snaps the panel into place and
    // drags the overlay's contents with it, fighting the slide-in animation.
    closeRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="-mr-2 p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors sm:hidden"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="mobile-nav"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      <div
        className={`fixed inset-0 z-50 overflow-hidden sm:hidden ${open ? '' : 'pointer-events-none'}`}
        inert={!open}
      >
        <div
          onClick={close}
          className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-250 motion-reduce:transition-none ${
            open ? 'opacity-100' : 'opacity-0'
          }`}
        />

        <nav
          id="mobile-nav"
          aria-label="Main menu"
          className={`absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col border-l border-border bg-bg-primary shadow-2xl transition-transform duration-250 ease-out motion-reduce:transition-none ${
            open ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          {/* Close button sits where the hamburger was, so the drawer reads as
              opening out of the header rather than landing on top of it. */}
          <div className="flex items-center justify-end p-4">
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              className="-mr-2 p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
              aria-label="Close menu"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {email && (
            <p className="truncate px-6 pb-4 text-xs text-text-muted">{email}</p>
          )}

          {/* Groups render as a heading plus indented links rather than a
              collapsible section: the drawer is full-height, so hiding a handful
              of admin links behind another tap would only add a step. */}
          <div className="flex flex-col border-t border-border">
            {items.map(entry => isNavGroup(entry) ? (
              <div key={entry.label} className="border-b border-border">
                <p className={`px-6 pt-4 pb-1 text-xs font-medium uppercase tracking-wider ${
                  entry.emphasis ? 'text-accent-primary' : 'text-text-muted'
                }`}>
                  {entry.label}
                </p>
                {entry.items.map(item => (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={close}
                    className={`block px-6 py-3 text-base hover:bg-bg-hover transition-colors ${
                      item.emphasis ? 'text-accent-primary font-medium' : 'text-text-primary'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : (
              <Link
                key={entry.to}
                to={entry.to}
                onClick={close}
                className={`border-b border-border px-6 py-4 text-base hover:bg-bg-hover transition-colors ${
                  entry.emphasis ? 'text-accent-primary font-medium' : 'text-text-primary'
                }`}
              >
                {entry.label}
              </Link>
            ))}
          </div>

          {onSignOut && (
            <button
              type="button"
              onClick={() => {
                close();
                onSignOut();
              }}
              className="mt-auto border-t border-border px-6 py-4 text-left text-base text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              Sign out
            </button>
          )}
        </nav>
      </div>
    </>
  );
}
