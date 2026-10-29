import { Link } from 'react-router-dom';

// The top of each page an artist manages from /my-artists (Edit, Releases, Tips, Promote): the way
// back, which page this is, the artist's name, and a link to their live page.
//
// These were tabs under one Edit page until 2026-10-29, when Brandon split them into pages of
// their own, each with its own button on the My Artists card: only Edit is about the profile.

export type ArtistSettingsSection = 'profile' | 'releases' | 'tips' | 'promote';

/** What each page is, above the artist's name. */
export const SECTION_LABELS: Record<ArtistSettingsSection, string> = {
  profile: 'Edit profile',
  releases: 'Manage releases',
  tips: 'Manage tips',
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
        <div>
          <p className="text-sm font-medium text-text-muted">{SECTION_LABELS[section]}</p>
          {artistName ? (
            <h1 className="font-display text-3xl font-extrabold text-text-primary">{artistName}</h1>
          ) : (
            <div className="h-9 w-48 rounded bg-bg-secondary animate-pulse" aria-hidden="true" />
          )}
        </div>
        <Link to={`/a/${slug}`} className="text-sm text-link hover:underline">
          View live profile
        </Link>
      </div>
    </div>
  );
}
