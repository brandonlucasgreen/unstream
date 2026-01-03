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
  | 'qobuz';

export interface Source {
  id: SourceId;
  name: string;
  description: string;
  color: string;
  icon: string;
  category: 'marketplace' | 'patronage' | 'library' | 'decentralized';
  hasEmbed: boolean;
  searchUrlTemplate: string;
  searchOnly?: boolean; // True if we can't verify the artist exists (shows "Search X" instead)
  homepageUrl: string;
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
  matchConfidence?: 'verified' | 'unverified';
}

// API response from /api/search/sources
export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

// Search state
export interface SearchState {
  query: string;
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;
}
