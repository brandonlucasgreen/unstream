import { sources } from '../services/sources';
import type { SourceId } from '../types';

// Platforms that support avatar scraping
export const AVATAR_PLATFORMS = new Set(['bandcamp', 'youtube', 'mirlo']);

// Platform name lookup
export function platformName(id: string): string {
  const CUSTOM_NAMES: Record<string, string> = {
    officialsite: 'Official Website',
    peertube: 'PeerTube',
    newsletter: 'Newsletter',
    wikipedia: 'Wikipedia',
    liberapay: 'Liberapay',
    other: 'Other',
  };
  if (CUSTOM_NAMES[id]) return CUSTOM_NAMES[id];
  const source = sources[id as SourceId];
  return source?.name || id;
}
