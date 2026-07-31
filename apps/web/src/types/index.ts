// Music source types
export type SourceId =
  | 'bandcamp'
  | 'mirlo'
  | 'ampwall'
  | 'subvert'
  | 'bandwagon'
  | 'faircamp'
  | 'patreon'
  | 'buymeacoffee'
  | 'kofi'
  | 'hoopla'
  | 'freegal'
  | 'qobuz'
  | 'beatport'
  | 'even'
  | 'jamcoop'
  | 'officialsite'
  | 'discogs'
  | 'instagram'
  | 'facebook'
  | 'tiktok'
  | 'youtube'
  | 'threads'
  | 'bluesky'
  | 'mastodon'
  | 'peertube'
  | 'newsletter'
  | 'wikipedia'
  | 'liberapay'
  | 'other';

export interface Source {
  id: SourceId;
  name: string;
  description: string;
  color: string;
  icon: string;
  category: 'marketplace' | 'patronage' | 'library' | 'decentralized' | 'official' | 'social' | 'curated';
  hasEmbed: boolean;
  searchUrlTemplate: string;
  searchOnly?: boolean; // True if we can't verify the artist exists (shows "Search X" instead)
  homepageUrl: string;
  artistPayoutPercent?: string; // e.g., "80-85%" - artist's share of sales on this platform
  aiPolicy?: 'formal' | 'discouraged'; // AI-generated content policy (marketplaces only)
  aiPolicyUrl?: string; // Link to platform's AI music policy page
}

// Latest release info
export interface LatestRelease {
  title: string;
  type: 'album' | 'track';
  url: string;
  imageUrl?: string;
  releaseDate?: string; // ISO date or human-readable date string
}

// Platform result from unified search
export interface PlatformLink {
  sourceId: SourceId;
  url: string;
  displayName?: string;
  latestRelease?: LatestRelease;
}

export interface ArtistLocation {
  city?: string;
  country?: string;
  countryCode?: string;
}

// Search result from the unified API
export interface SearchResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: PlatformLink[];
  // Match confidence: 'verified' means we know who this is — releases match across
  // platforms, a curated platform lists them, or MusicBrainz identified them (see
  // musicBrainzConfirmed); 'unverified' means a name-only match we couldn't confirm;
  // 'claimed' means the artist has verified ownership of this profile.
  matchConfidence?: 'verified' | 'unverified' | 'claimed';
  // Why an 'unverified' result is unverified. 'conflicting-releases' means this
  // platform's releases didn't match a verified sibling result — it may be a
  // different artist with the same name, and that warrants a warning.
  // 'no-release-data' means we had nothing to compare against, which is not a
  // warning about the result. Absent for results restored from the DB; treat
  // that like 'no-release-data'. Mirrors api/functions/search-utils.ts.
  unverifiedReason?: 'conflicting-releases' | 'no-release-data';
  // MusicBrainz matched this artist and supplied real destinations for them.
  // Counts as verification on its own — see api/functions/search-utils.ts.
  musicBrainzConfirmed?: boolean;
  // Slug for claimed artist page (/a/{slug})
  claimedSlug?: string;
  // Wikipedia bio summary from MusicBrainz enrichment
  wikipediaSummary?: string;
  wikipediaUrl?: string;
  // Geographic location from MusicBrainz, Bandcamp, or Mirlo enrichment
  location?: ArtistLocation;
}

// API response from /api/search/sources
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  hasPendingEnrichment?: boolean; // True if MusicBrainz data should be fetched separately
}

// Social link from MusicBrainz
export interface SocialLink {
  platform: 'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'threads' | 'bluesky' | 'mastodon' | 'peertube' | 'patreon' | 'kofi' | 'buymeacoffee';
  url: string;
}

// MusicBrainz enrichment data (fetched separately for lazy loading)
export interface MusicBrainzData {
  query: string;
  artistName: string | null;
  officialUrl: string | null;
  discogsUrl: string | null;
  hasPre2005Release: boolean;
  socialLinks: SocialLink[];
  platformUrls?: string[];
  wikipediaSummary?: string | null;
  wikipediaUrl?: string | null;
  location?: ArtistLocation;
}

// Search state
export interface SearchState {
  query: string;
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;
}
