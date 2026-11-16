import type { ArtistPagePayload } from '../types/artist-page';

/** "City, Country", or whichever half we have, or '' when we know neither. */
export function getLocationText(artist: ArtistPagePayload['artist']): string {
  const region = artist.country || artist.countryCode;
  if (artist.city && region) return `${artist.city}, ${region}`;
  if (artist.city) return artist.city;
  if (region) return region;
  return '';
}
