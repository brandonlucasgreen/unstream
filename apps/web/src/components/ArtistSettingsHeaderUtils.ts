import type { ArtistSettingsSection } from './ArtistSettingsHeader';

/** What each page is, before the artist's name in its heading. */
export const SECTION_LABELS: Record<ArtistSettingsSection, string> = {
  analytics: 'Analytics',
  profile: 'Edit Page',
  releases: 'Manage Releases',
  tips: 'Manage Tips',
  promote: 'Promote',
};
