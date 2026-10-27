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
  | 'venmo'
  | 'paypal'
  | 'cashapp'
  | 'steady'
  | 'tipeee'
  | 'bigcartel'
  | 'other';

export interface Source {
  id: SourceId;
  name: string;
  description: string;
  color: string;
  icon: string;
  category: 'marketplace' | 'patronage' | 'library' | 'decentralized' | 'official' | 'social' | 'curated';
  /**
   * Which artist-page section (UNS-221) a claimed artist's link in this platform renders in.
   * Mirrors api/shared/platform-registry.ts (parity-tested); absent = `marketplaces`.
   */
  sectionCategory?: 'patronage' | 'official' | 'social';
  hasEmbed: boolean;
  searchUrlTemplate: string;
  searchOnly?: boolean; // True if we can't verify the artist exists (shows "Search X" instead)
  homepageUrl: string;
  artistPayoutPercent?: string; // e.g., "80-85%" - artist's share of sales on this platform
  aiPolicy?: 'formal' | 'discouraged'; // AI-generated content policy, where the platform publishes one
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
  // Slug for an unclaimed-but-known artist's pre-generated page (/artist/{slug})
  knownSlug?: string;
  // Deprecated: superseded by `bio`, which covers every source. Kept until the backend stops
  // sending it.
  wikipediaSummary?: string;
  wikipediaUrl?: string;
  // Short bio for the card, picked on the server. Mirrors api/shared/artist-bio.ts.
  bio?: ArtistBio;
  // A claimed artist turned bios off; Phase 2 must not fill one in.
  bioSuppressed?: boolean;
  // A Wikimedia Commons photo, sent only for a card with no imageUrl. Never shown without its
  // credit, and never saved: that is why it isn't imageUrl. Mirrors api/search/commons-photo.ts.
  commonsPhoto?: CommonsPhoto;
  // Geographic location from MusicBrainz, Bandcamp, or Mirlo enrichment
  location?: ArtistLocation;
  // The artist takes tips on Unstream right now: show Tip (→ /tip/{slug}).
  tipsEnabled?: boolean;
}

// API response from /api/search/sources
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  hasPendingEnrichment?: boolean; // True if MusicBrainz data should be fetched separately
  // Client-only: a multi-artist search where some of the split queries failed, so these
  // results are what the rest returned. Never sent by the server.
  partial?: boolean;
}

// A freely licensed artist photo from Wikimedia Commons and the credit its licence requires.
export interface CommonsPhoto {
  url: string;
  // Plain text; '' only for a public-domain photo.
  author: string;
  // e.g. "CC BY-SA 2.0"
  license: string;
  // The Commons file page, where the full attribution lives.
  sourceUrl: string;
}

// A short artist bio — one source, never stitched together. `text` is plain text with
// paragraphs separated by a blank line; render it as text, never as HTML.
export interface ArtistBio {
  text: string;
  source: 'unstream' | 'bandcamp' | 'discogs' | 'wikipedia';
  // Where the full bio lives. Always present — it's the "read more" link.
  sourceUrl: string;
  // The server cut a long bio short, so the full text is only at sourceUrl.
  truncated: boolean;
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
  // Only fills a card with none — see mergeWithMusicBrainzData.
  bio?: ArtistBio | null;
  // Likewise: only for a card with no photo, and never a claimed one.
  commonsPhoto?: CommonsPhoto | null;
  // The Bandcamp account MusicBrainz lists for this artist, even if retired. A result on a
  // different subdomain is a same-name stranger and must not be enriched.
  bandcampSubdomain?: string | null;
  // Other artists MusicBrainz lists under exactly this name. When there are any, only a card
  // on `bandcampSubdomain` is this artist — see nameMatchIsSameArtist.
  homonyms?: MusicBrainzHomonym[];
}

// Another artist with the same name, with only their own MusicBrainz links (see
// MusicBrainzHomonym in api/functions/musicbrainz-enrichment.ts).
export interface MusicBrainzHomonym {
  mbid: string;
  name: string;
  disambiguation: string | null;
  officialUrl: string | null;
  bandcampUrl: string | null;
  bandcampSubdomain: string | null;
  socialLinks: SocialLink[];
  platformUrls: string[];
  location?: ArtistLocation;
}

// Search state
export interface SearchState {
  query: string;
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;
}
