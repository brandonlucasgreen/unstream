import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { TipSheet } from './TipSheet';

// The Tip button (docs/specs/artist-patronage-spec.md §3.1), shown only for an artist taking tips.
// It opens the tip window over the current page. It's still a real link to /tip/{slug}, so opening it
// in a new tab, or copying it, gives the full tip page.

/** A link to an artist's tip page that opens the tip window instead on a plain click. */
export function TipLink({ slug, artistName, goalId, className, children }: {
  slug: string;
  artistName: string;
  goalId?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const href = goalId ? `/tip/${slug}?goal=${encodeURIComponent(goalId)}` : `/tip/${slug}`;

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    // Cmd/Ctrl/Shift-click and middle-click keep their usual meaning: a new tab or window.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setOpen(true);
  };

  return (
    <>
      <Link to={href} onClick={onClick} className={className}>
        {children}
      </Link>
      {open && <TipSheet slug={slug} artistName={artistName} goalId={goalId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function TipButton({ slug, artistName }: { slug: string; artistName: string }) {
  return (
    <TipLink
      slug={slug}
      artistName={artistName}
      className="inline-flex items-center gap-1.5 min-h-11 px-3 py-2 rounded-lg border border-accent-primary bg-accent-primary text-white text-sm hover:bg-accent-primary/90 transition-colors"
    >
      <span aria-hidden="true">♥</span>
      Tip {artistName}
    </TipLink>
  );
}
