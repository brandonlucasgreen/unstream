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
  socialLinks: Array<{
    platform: string;
    url: string;
    displayName: string | null;
  }>;
  bandcampFriday: boolean;
}