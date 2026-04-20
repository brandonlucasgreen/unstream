// Music source types
export type SourceId =
  | 'bandcamp'
  | 'mirlo'
  | 'ampwall'
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
  aiPolicy?: 'banned' | 'anti-ai' | 'disclosed' | 'unknown' | 'self-hosted'; // AI-generated content policy
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

// Search result from the unified API
export interface SearchResult {
  id: string;
  name: string;
  artist?: string;
  type: 'artist' | 'album' | 'track';
  imageUrl?: string;
  platforms: PlatformLink[];
  // Match confidence: 'verified' means releases match across platforms,
  // 'unverified' means name-only match (no release data to compare)
  // 'claimed' means artist has verified ownership of this profile
  matchConfidence?: 'verified' | 'unverified' | 'claimed';
  // Slug for claimed artist page (/a/{slug})
  claimedSlug?: string;
  // Wikipedia bio summary from MusicBrainz enrichment
  wikipediaSummary?: string;
  wikipediaUrl?: string;
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
}

// Search state
export interface SearchState {
  query: string;
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;
}
