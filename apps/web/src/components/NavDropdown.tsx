import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { NavGroup } from './MobileNav';

/**
 * Desktop-only nav dropdown for a group of links (currently the admin pages).
 *
 * Closes on outside click, Escape, and navigation. The mobile drawer renders the
 * same group inline instead — see MobileNav.
 */
export function NavDropdown({ group }: { group: NavGroup }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        className={`flex items-center gap-1 transition-colors ${
          group.emphasis
            ? 'text-accent-primary font-medium hover:underline'
            : 'text-text-muted hover:text-text-primary'
        }`}
      >
        {group.label}
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 min-w-44 rounded-xl border border-border bg-bg-primary py-1 shadow-lg">
          {group.items.map(item => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={`block px-4 py-2 text-sm hover:bg-bg-hover transition-colors ${
                item.emphasis ? 'text-accent-primary font-medium' : 'text-text-primary'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
