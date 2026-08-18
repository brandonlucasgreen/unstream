/**
 * Shared platform registry — single source of truth for platform metadata.
 *
 * Used by:
 * - apps/web/src/services/sources.ts (client-side source config)
 * - api/edge/*.ts (SSR/SEO edge functions)
 *
 * When adding or updating a platform, edit ONLY this file.
 * Then run: grep -r "PLATFORM_INFO" api/edge/ apps/web/src/ to find stale copies.
 */

export interface PlatformMeta {
  name: string;
  color: string;
  icon: string;
  category: string;
  payoutPercent?: string;
  searchOnly?: boolean;
  homepageUrl?: string;
  aiPolicy?: 'formal' | 'discouraged';
  aiPolicyUrl?: string;
  /**
   * The platform sells downloads and nothing physical.
   *
   * Read by `releaseTypeLabel` to say "Digital" about a release whose *kind* (album/EP/single)
   * the upstream never told us — which is the normal case on exactly these platforms, since none
   * of them expose a type field. Absent means "not established", not "sells physical": Bandcamp
   * and Discogs are deliberately unflagged because they genuinely sell vinyl, cassettes and CDs,
   * and so is anything we haven't verified. An unflagged platform simply produces no label, which
   * is the honest outcome — this field exists to state a fact about a shop, so a guess here would
   * put a wrong claim about a physical product on a release page.
   */
  digitalOnly?: true;
}

export const PLATFORMS: Record<string, PlatformMeta> = {
  // Marketplaces
  bandcamp: {
    name: 'Bandcamp',
    color: '#1da0c3',
    icon: '🎵',
    category: 'marketplace',
    payoutPercent: '80-85%',
    searchOnly: true,
    homepageUrl: 'https://bandcamp.com',
    aiPolicy: 'formal',
    aiPolicyUrl: 'https://blog.bandcamp.com/2026/01/13/keeping-bandcamp-human/',
  },
  mirlo: {
    name: 'Mirlo',
    color: '#BE3455',
    icon: '🪺',
    category: 'marketplace',
    payoutPercent: '86-90%',
    // Verified live 2026-08-05: every trackGroup is a download. Artists can link a merch store
    // (`merchStoreURL`), but that is off-platform and never a release row.
    digitalOnly: true,
    homepageUrl: 'https://mirlo.space',
    aiPolicy: 'formal',
    aiPolicyUrl: 'https://mirlo.space/pages/content-policy',
  },
  ampwall: {
    name: 'Ampwall',
    color: '#1E1E24',
    icon: '🔊',
    category: 'marketplace',
    payoutPercent: '92-95%',
    searchOnly: true,
    homepageUrl: 'https://ampwall.com',
    aiPolicy: 'formal',
    aiPolicyUrl: 'https://ampwall.com/content-policy',
  },
  subvert: {
    name: 'Subvert',
    color: '#D9DBDD',
    icon: '🌐',
    category: 'marketplace',
    payoutPercent: '97%',
    searchOnly: true,
    homepageUrl: 'https://www.subvert.fm',
    aiPolicy: 'formal',
    aiPolicyUrl: 'https://www.subvert.fm/pages/ai-policy',
  },
  qobuz: {
    name: 'Qobuz',
    color: '#0070f3',
    icon: '💿',
    category: 'marketplace',
    payoutPercent: '~70%',
    homepageUrl: 'https://www.qobuz.com',
    aiPolicy: 'formal',
    aiPolicyUrl: 'https://community.qobuz.com/ai-charter',
  },
  beatport: {
    name: 'Beatport',
    color: '#01FF95',
    icon: '🎛️',
    category: 'marketplace',
    payoutPercent: '55-70%',
    homepageUrl: 'https://www.beatport.com',
    // Formal ban on fully/majority AI-generated tracks (Aug 2026): withheld at ingestion,
    // rights holders notified. AI-assisted tracks (mixing/mastering/stem separation) are
    // still allowed but tagged as such. Detection via Beatdapp.
    aiPolicy: 'formal',
    aiPolicyUrl: 'https://support.beatport.com/hc/en-us/articles/52381231418004-Beatport-s-Stance-on-Artificial-Intelligence',
  },
  even: {
    name: 'EVEN',
    color: '#000000',
    icon: '🎤',
    category: 'marketplace',
    payoutPercent: '~80%',
    homepageUrl: 'https://even.biz',
  },
  jamcoop: {
    name: 'Jam.coop',
    color: '#D97706',
    icon: '🎸',
    category: 'marketplace',
    // A range, not a flat 85%: the co-op takes 15% "minimum 20p" per sale
    // (https://jam.coop/docs/about). The 20p floor is what bites on cheap releases —
    // on a £1.00 sale the fee is 20p (20%), not 15p — and plenty of Jam.coop releases
    // sell for £0.75–£3.00, so the effective payout at the low end is under 85%.
    payoutPercent: '82-85%',
    // Every album page states "Digital download. MP3 and FLAC"; there is no physical stock,
    // which is also why `ingestJamcoopAlbumPage` types every offer 'digital'.
    digitalOnly: true,
    homepageUrl: 'https://jam.coop',
  },
  discogs: {
    name: 'Discogs',
    color: '#333333',
    icon: '💿',
    category: 'marketplace',
    homepageUrl: 'https://www.discogs.com',
  },

  // Self-hosted & Decentralized
  bandwagon: {
    name: 'Bandwagon',
    color: '#8b5cf6',
    icon: '🚐',
    category: 'decentralized',
    homepageUrl: 'https://bandwagon.fm',
    aiPolicy: 'formal',
    aiPolicyUrl: 'https://bandwagon.fm/acceptable-use',
  },
  faircamp: {
    name: 'Faircamp',
    color: '#22c55e',
    icon: '🏕️',
    category: 'decentralized',
    payoutPercent: '90-97%',
    // A static-site generator for selling downloads. No cart, no stock, no shipping.
    digitalOnly: true,
    homepageUrl: 'https://simonrepp.com/faircamp',
  },

  // Patronage
  patreon: {
    name: 'Patreon',
    color: '#ff424d',
    icon: '🎨',
    category: 'patronage',
    payoutPercent: '86-90%',
    homepageUrl: 'https://www.patreon.com',
  },
  buymeacoffee: {
    name: 'Buy Me a Coffee',
    color: '#ffdd00',
    icon: '☕',
    category: 'patronage',
    payoutPercent: '~92%',
    searchOnly: true,
    homepageUrl: 'https://buymeacoffee.com',
  },
  kofi: {
    name: 'Ko-fi',
    color: '#29abe0',
    icon: '🍵',
    category: 'patronage',
    payoutPercent: '92-97%',
    searchOnly: true,
    homepageUrl: 'https://ko-fi.com',
  },
  liberapay: {
    name: 'Liberapay',
    color: '#F6C915',
    icon: '🤝',
    category: 'patronage',
    homepageUrl: 'https://liberapay.com',
  },

  // Library
  hoopla: {
    name: 'Hoopla',
    color: '#9333ea',
    icon: '🎧',
    category: 'library',
    homepageUrl: 'https://www.hoopladigital.com',
  },
  freegal: {
    name: 'Freegal',
    color: '#e91e63',
    icon: '🎵',
    category: 'library',
    homepageUrl: 'https://www.freegalmusic.com',
  },

  // Official
  officialsite: {
    name: 'Official Site',
    color: '#71717a',
    icon: '⭐',
    category: 'official',
    homepageUrl: '',
  },
  wikipedia: {
    name: 'Wikipedia',
    color: '#636466',
    icon: '📖',
    category: 'official',
    homepageUrl: 'https://en.wikipedia.org',
  },

  // Social
  instagram: {
    name: 'Instagram',
    color: '#E4405F',
    icon: 'instagram',
    category: 'social',
    homepageUrl: 'https://www.instagram.com',
  },
  facebook: {
    name: 'Facebook',
    color: '#1877F2',
    icon: 'facebook',
    category: 'social',
    homepageUrl: 'https://www.facebook.com',
  },
  tiktok: {
    name: 'TikTok',
    color: '#E0E0E0',
    icon: 'tiktok',
    category: 'social',
    homepageUrl: 'https://www.tiktok.com',
  },
  youtube: {
    name: 'YouTube',
    color: '#FF0000',
    icon: 'youtube',
    category: 'social',
    homepageUrl: 'https://www.youtube.com',
  },
  threads: {
    name: 'Threads',
    color: '#E0E0E0',
    icon: 'threads',
    category: 'social',
    homepageUrl: 'https://www.threads.net',
  },
  bluesky: {
    name: 'Bluesky',
    color: '#0085FF',
    icon: 'bluesky',
    category: 'social',
    homepageUrl: 'https://bsky.app',
  },
  mastodon: {
    name: 'Mastodon',
    color: '#6364FF',
    icon: 'mastodon',
    category: 'social',
    homepageUrl: 'https://mastodon.social',
  },
  peertube: {
    name: 'PeerTube',
    color: '#F1680D',
    icon: 'peertube',
    category: 'social',
    homepageUrl: 'https://joinpeertube.org',
  },
  newsletter: {
    name: 'Newsletter',
    color: '#666',
    icon: '📧',
    category: 'social',
    homepageUrl: '',
  },

  // Legacy/edge-only platforms (appear in MusicBrainz enrichment but not main search)
  funkwhale: {
    name: 'Funkwhale',
    color: '#0084c7',
    icon: '🐋',
    category: 'decentralized',
  },
  internetarchive: {
    name: 'Internet Archive',
    color: '#428bca',
    icon: '🏛️',
    category: 'library',
  },
};

/** Category display order and labels */
export const CATEGORY_ORDER: { key: string; name: string; description: string }[] = [
  { key: 'marketplace', name: 'Music Marketplaces', description: 'Buy music directly from artists' },
  { key: 'patronage', name: 'Patronage Platforms', description: 'Support artists directly' },
  { key: 'decentralized', name: 'Self-hosted & Decentralized', description: 'ActivityPub and self-hosted platforms' },
  { key: 'library', name: 'Library Services', description: 'Access through your local library' },
  { key: 'official', name: 'Official', description: 'Artist websites and profiles' },
  { key: 'social', name: 'Social', description: 'Artist social media profiles' },
];