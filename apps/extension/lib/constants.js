// Shared constants for the Unstream extension.
// PAYOUT_PERCENTAGES must be kept in sync with apps/web/src/services/sources.ts.
// Run `npm run sync:bandcamp-dates` after updating Bandcamp Friday dates in the web app.

export const ALLOWED_RELEASE_DOMAINS = [
  'bandcamp.com',
  'mirlo.space',
  'qobuz.com',
  'ampwall.com',
  'faircamp.eu',
];

export const SOURCE_CONFIG = {
  bandcamp: { icon: '🎵', name: 'Bandcamp' },
  qobuz: { icon: '💿', name: 'Qobuz' },
  jamcoop: { icon: '🎸', name: 'Jam.coop' },
  officialsite: { icon: '🌐', name: 'Official Site' },
  discogs: { icon: '💿', name: 'Discogs' },
  mirlo: { icon: '🪺', name: 'Mirlo' },
  faircamp: { icon: '🏕️', name: 'Faircamp' },
  bandwagon: { icon: '🚐', name: 'Bandwagon' },
  nina: { icon: '🎵', name: 'Nina Protocol' },
  patreon: { icon: '🎨', name: 'Patreon' },
  kofi: { icon: '☕', name: 'Ko-fi' },
  buymeacoffee: { icon: '☕', name: 'Buy Me a Coffee' },
  ampwall: { icon: '🔊', name: 'Ampwall' },
  hoopla: { icon: '🎧', name: 'Hoopla' },
  freegal: { icon: '🎵', name: 'Freegal' },
};

// Keep in sync with artistPayoutPercent in apps/web/src/services/sources.ts
export const PAYOUT_PERCENTAGES = {
  bandcamp: '80-85%',
  mirlo: '86-90%',
  ampwall: '92-95%',
  faircamp: '90-97%',
  patreon: '86-90%',
  buymeacoffee: '~92%',
  kofi: '92-97%',
  qobuz: '~70%',
  beatport: '55-70%',
  // Range, not a flat 85%: 15% fee with a 20p minimum (https://jam.coop/docs/about),
  // so cheap releases pay out less. See api/shared/platform-registry.ts.
  jamcoop: '82-85%',
};
