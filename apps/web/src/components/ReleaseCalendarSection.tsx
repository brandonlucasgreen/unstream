import { ReleaseFeedControls } from './ReleaseFeedControls';

/**
 * The private release calendar, on /my-saved-artists: one subscription (calendar or RSS) covering
 * every artist the fan has saved.
 *
 * It heads the page that lists the artists it follows (Brandon, 2026-11-08), and only there: it
 * covers saved artists, not the collection, so /my-collection doesn't mention it. Before that it
 * sat under Releases on /my-collection, and before *that* on /settings, where in months of being
 * live not one fan ever minted a token. The page renders it only once the fan has saved somebody
 * — a feed of nobody carries nothing — and shows `ReleaseFeedOffSwitch` in its place otherwise.
 *
 * Rendering it mints nothing: `ReleaseFeedControls` asks for a token only when pressed.
 */
export function ReleaseCalendarSection() {
  return (
    <section>
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
