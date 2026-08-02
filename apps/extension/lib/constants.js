// Shared constants for the Unstream extension.
// PAYOUT_PERCENTAGES must be kept in sync with apps/web/src/services/sources.ts.
// Run `npm run sync:bandcamp-dates` after updating Bandcamp Friday dates in the web app.

// Where a release alert is allowed to send someone. Guards both the popup's link and the
// notification click, so an alert can never open an arbitrary URL.
//
// `unstream.stream` is first because it is now the *usual* destination, not an exception: a
// catalogued release's `releaseUrl` is our own release page, so a fan lands on the payout
// comparison rather than one shop. Leaving it out meant every catalog-backed alert had a Listen
// button and a notification that silently did nothing when clicked.
export const ALLOWED_RELEASE_DOMAINS = [
  'unstream.stream',
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
