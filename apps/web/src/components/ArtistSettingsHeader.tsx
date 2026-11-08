import { Link } from 'react-router-dom';

// The top of each page an artist manages (Analytics, Edit, Releases, Tips, Promote): one heading
// saying which page and which artist ("Manage Tips: Kid Lightbulbs", Brandon, 2026-10-29), and a
// link to their live page.
//
// These were tabs under one Edit page until 2026-10-29, when Brandon split them into pages of
// their own, each with its own button on the My Artists card: only Edit is about the profile.
// There is no "← My Artists" link: the header's artist menu reaches every one of these pages
// (Brandon, 2026-11-08).

export type ArtistSettingsSection = 'analytics' | 'profile' | 'releases' | 'tips' | 'promote';

/** What each page is, before the artist's name in its heading. */
export const SECTION_LABELS: Record<ArtistSettingsSection, string> = {
  analytics: 'Analytics',
  profile: 'Edit Page',
  releases: 'Manage Releases',
  tips: 'Manage Tips',
  promote: 'Promote',
};

export function ArtistSettingsHeader({ slug, artistName, section }: {
  slug: string;
  /** Undefined while the page is still loading it. */
  artistName?: string;
  section: ArtistSettingsSection;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h1 className="font-display text-3xl font-extrabold text-text-primary">
          {SECTION_LABELS[section]}:{' '}
          {artistName ?? (
            // The name arrives with the page's own data; hold its place until then.
            <span className="inline-block h-7 w-40 align-middle rounded bg-bg-secondary animate-pulse" aria-hidden="true" />
          )}
        </h1>
        <Link to={`/a/${slug}`} className="text-sm text-link hover:underline">
          View live profile
        </Link>
      </div>
    </div>
  );
}
