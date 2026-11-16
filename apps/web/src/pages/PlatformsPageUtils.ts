import { sources, sourceCategories } from '../services/sources';
import type { Source } from '../types';

// The groups the Platforms page lists, kept out of PlatformsPage.tsx so that file exports only
// its component.
//
// Official, social and the emptied `decentralized` bucket (UNS-226) are left out: officials
// and socials are where an artist is, not ways to pay them, and an empty bucket renders as
// a heading over nothing.
const SUPPORT_CATEGORIES = ['marketplace', 'patronage', 'library'] as const;

export function supportPlatformGroups(): { key: string; name: string; description: string; platforms: Source[] }[] {
  return SUPPORT_CATEGORIES.map((key) => ({
    key,
    name: sourceCategories[key].name,
    description: sourceCategories[key].description,
    platforms: sourceCategories[key].sources.map((id) => sources[id]),
  }));
}
