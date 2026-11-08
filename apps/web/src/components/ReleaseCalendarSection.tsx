import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { ReleaseFeedControls } from './ReleaseFeedControls';

/**
 * The private release calendar, on /my-saved-artists: one subscription (calendar or RSS) covering
 * every artist the fan has saved.
 *
 * It lives beside the list it follows (Brandon, 2026-11-08). Before that it sat under Releases on
 * /my-collection, and before *that* on /settings, where in months of being live not one fan ever
 * minted a token. The page only renders this once the fan has saved somebody — a feed of nobody
 * carries nothing — and revoking stays on /settings (`ReleaseFeedOffSwitch`), since a token
 * outlives the saved artists that justified it.
 *
 * Rendering it mints nothing: `ReleaseFeedControls` asks for a token only when pressed.
 *
 * The Releases section on /my-collection links to `#release-calendar`. React Router doesn't jump
 * to a fragment on navigation, so this does it once mounted.
 */
export function ReleaseCalendarSection() {
  const location = useLocation();
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (location.hash === '#release-calendar') sectionRef.current?.scrollIntoView();
  }, [location.hash]);

  return (
    <section id="release-calendar" ref={sectionRef} className="scroll-mt-24">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <CalendarIcon />
        <RssIcon />
        Release calendar
      </h2>
      <div className="p-4 rounded-lg bg-bg-secondary border border-border">
        <ReleaseFeedControls />
      </div>
    </section>
  );
}

/**
 * The same pair as `ReleasesSection`'s heading, drawn as strokes at the same weight so they read
 * as one mark rather than two icons from different sets — the two formats the one feed token
 * serves.
 *
 * `aria-hidden` because the heading's own text names the thing.
 */
function CalendarIcon() {
  return (
    <svg
      className="w-5 h-5 text-link"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function RssIcon() {
  return (
    <svg
      className="w-5 h-5 text-link"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 11a9 9 0 019 9M4 4a16 16 0 0116 16" />
      <circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
