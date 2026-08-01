export interface ArtistPagePayload {
  artist: {
    id: string;
    slug: string;
    name: string;
    imageUrl: string | null;
    matchConfidence: 'verified' | 'unverified' | 'claimed';
    country: string | null;
    countryCode: string | null;
    city: string | null;
  };
  profile: {
    bio: string | null;
    customImageUrl: string | null;
    featuredEmbed: string | null;
    verifiedAt: string | null;
  } | null;
  links: Array<{
    platform: string;
    url: string;
    displayName: string | null;
    payoutPercent: string | null;
    bandcampFriday: boolean;
  }>;
  // Indexes into `links` above which the artist placed a horizontal divider.
  // Older cached responses may omit it — treat a missing value as no dividers.
  linkDividers?: number[];
  socialLinks: Array<{
    platform: string;
    url: string;
    displayName: string | null;
  }>;
  // Newest first, capped. Older cached responses omit both — treat as no releases.
  releases?: Array<{
    slug: string;
    title: string;
    releaseType: string;
    releaseDate: string | null;
    datePrecision: string | null;
    status: string;
    artworkUrl: string | null;
    // Kept per-source (not flattened) so the UI can show *where* a release is available, not
    // just the cheapest price across everywhere it happens to be sold.
    sources: Array<{
      platform: string;
      offers: Array<{ price: number | null; currency: string | null; availability: string }>;
    }>;
  }>;
  /** Total before the cap, so the UI can say how many are not shown. */
  releaseCount?: number;
  bandcampFriday: boolean;
}