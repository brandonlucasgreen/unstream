import { Link, Outlet, useMatch, useOutletContext, useParams } from 'react-router-dom';
import type { ArtistSettingsContext } from '../pages/ArtistSettingsLayout';

// The tabs along the top of /promote/:slug: one per promotion tool (Brandon, 2026-10-30). Only
// Autopost exists so far; custom images for autopost, on-demand social cards and the embeddable
// widget are expected to join it. Each tab is its own route under /promote/:slug, so it can be
// linked to directly.
//
// **Autopost stays at /promote/:slug itself**, not a path of its own: Buffer's OAuth comes back
// there (isAllowedReturnPath in api/functions/me-buffer.ts) and the Promote button on /my-artists
// links there. A new tab takes a path below it (/promote/:slug/cards, say).

const TABS: { label: string; path: string }[] = [
  { label: 'Autopost', path: '' },
];

export function PromoteTabs({ slug }: { slug: string }) {
  const base = `/promote/${encodeURIComponent(slug)}`;
  // Matched against the route pattern, which the encoded slug can't upset.
  const match = useMatch('/promote/:slug/*');
  const current = match?.params['*']?.replace(/\/+$/, '') ?? '';
  return (
    <nav aria-label="Promotion tools" className="flex gap-1 border-b border-border overflow-x-auto">
      {TABS.map(tab => (
        <Link
          key={tab.label}
          to={tab.path ? `${base}/${tab.path}` : base}
          aria-current={tab.path === current ? 'page' : undefined}
          className={`inline-flex items-center min-h-11 px-2 sm:px-3 -mb-px border-b-2 text-sm whitespace-nowrap transition-colors ${
            tab.path === current
              ? 'border-accent-primary text-text-primary font-medium'
              : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The tabs above whichever tool is open. Passes the settings frame's context on, so each tool can
 * still hand the artist's name up to the heading (useReportArtistName).
 */
export function PromoteTabsLayout() {
  const { slug } = useParams<{ slug: string }>();
  const context = useOutletContext<ArtistSettingsContext>();
  if (!slug) return null;
  return (
    <div className="space-y-6">
      <PromoteTabs slug={slug} />
      <Outlet context={context} />
    </div>
  );
}
