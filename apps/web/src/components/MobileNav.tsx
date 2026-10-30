import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';

export type NavItem = {
  to: string;
  label: string;
  /** Accent-coloured, for a destination needing attention (an admin queue with items in it). */
  emphasis?: boolean;
  /**
   * Render as a filled button in the desktop header. The drawer ignores this —
   * every row there is already a full-width tap target in the primary text
   * colour, so a button inside the list would only add noise.
   */
  button?: boolean;
  /** `to` is a full URL to an outside site (e.g. Contact) — render a plain `<a>`, not a router `Link`. */
  external?: boolean;
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
 * Built on Dialog's drawer variant, a modal <dialog>: the page behind is inert
 * (the old overlay left it keyboard-focusable), Tab stays in the drawer, and
 * every way out — the close button, Escape, the backdrop, a link — goes through
 * one close that returns focus to the hamburger. The old Escape handler skipped
 * that. It slides in; it closes without sliding out (see Dialog for why).
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
  const { t } = useTranslation();

  // Widening past `sm` while open would leave a modal drawer over a desktop header that no longer
  // shows the hamburger to close it; close it instead.
  useEffect(() => {
    if (!open) return;
    const wide = window.matchMedia('(min-width: 640px)');
    const handleChange = () => { if (wide.matches) setOpen(false); };
    wide.addEventListener('change', handleChange);
    return () => wide.removeEventListener('change', handleChange);
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="-mr-2 p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors md:hidden"
        aria-label={t('nav.openMenu')}
        aria-expanded={open}
        aria-controls={open ? 'mobile-nav' : undefined}
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      {open && (
      <Dialog
        variant="drawer"
        labelledBy="mobile-nav-title"
        onClose={() => setOpen(false)}
        initialFocusRef={closeRef}
        returnFocusRef={triggerRef}
      >
        {close => (
        <nav
          id="mobile-nav"
          aria-label={t('nav.mainMenu')}
          className="flex h-full flex-col"
        >
          <h2 id="mobile-nav-title" className="sr-only">{t('nav.mainMenu')}</h2>
          {/* Close button sits where the hamburger was, so the drawer reads as
              opening out of the header rather than landing on top of it. */}
          <div className="flex items-center justify-end p-4">
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              className="-mr-2 p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
              aria-label={t('nav.closeMenu')}
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
                  entry.emphasis ? 'text-link' : 'text-text-muted'
                }`}>
                  {entry.label}
                </p>
                {entry.items.map(item => (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={close}
                    className={`block px-6 py-3 text-base hover:bg-bg-hover transition-colors ${
                      item.emphasis ? 'text-link font-medium' : 'text-text-primary'
                    }`}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : entry.external ? (
              <a
                key={entry.to}
                href={entry.to}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
                className={`border-b border-border px-6 py-4 text-base hover:bg-bg-hover transition-colors ${
                  entry.emphasis ? 'text-link font-medium' : 'text-text-primary'
                }`}
              >
                {entry.label}
              </a>
            ) : (
              <Link
                key={entry.to}
                to={entry.to}
                onClick={close}
                className={`border-b border-border px-6 py-4 text-base hover:bg-bg-hover transition-colors ${
                  entry.emphasis ? 'text-link font-medium' : 'text-text-primary'
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
              {t('nav.signOut')}
            </button>
          )}
        </nav>
        )}
      </Dialog>
      )}
    </>
  );
}
