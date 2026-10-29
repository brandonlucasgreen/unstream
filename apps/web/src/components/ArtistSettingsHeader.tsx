import { Link } from 'react-router-dom';

// The top of each page an artist manages from /my-artists (Edit, Releases, Tips, Promote): the way
// back, one heading saying which page and which artist ("Manage Tips: Kid Lightbulbs", Brandon,
// 2026-10-29), and a link to their live page.
//
// These were tabs under one Edit page until 2026-10-29, when Brandon split them into pages of
// their own, each with its own button on the My Artists card: only Edit is about the profile.

export type ArtistSettingsSection = 'profile' | 'releases' | 'tips' | 'promote';

/** What each page is, before the artist's name in its heading. */
export const SECTION_LABELS: Record<ArtistSettingsSection, string> = {
  profile: 'Edit Profile',
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
      <Link to="/my-artists" className="text-sm text-text-muted hover:text-text-primary transition-colors">
        &larr; My Artists
      </Link>
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
