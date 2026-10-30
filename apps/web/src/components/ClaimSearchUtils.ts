import { sources } from '../services/sources';
import type { SearchResult } from '../types';

export interface ClaimRow {
  id: string;
  name: string;
  imageUrl?: string;
  location: string;
  platformNames: string[];
  /** Claimed rows link to the artist's page; the rest link into the claim flow. */
  action: { kind: 'claimed'; href: string } | { kind: 'claim'; href: string };
}

// Where a fan pays the artist. Socials and official sites say where an artist is, not
// which artist this is, and would crowd out the stores that tell two same-name rows apart.
const SHOWN_CATEGORIES = new Set(['marketplace', 'patronage']);
const MAX_PLATFORM_NAMES = 4;

/**
 * The search results an artist can act on from /for-artists, one row each. Albums and tracks
 * are dropped, and so is any artist without a stored slug — a MusicBrainz-only card has no row
 * to claim, the same rule ResultCardActions follows for its Claim link.
 */
export function claimRows(results: SearchResult[]): ClaimRow[] {
  const rows: ClaimRow[] = [];
  for (const result of results) {
    if (result.type !== 'artist') continue;

    let action: ClaimRow['action'];
    if (result.matchConfidence === 'claimed') {
      const slug = result.claimedSlug ?? result.knownSlug;
      if (!slug) continue;
      action = { kind: 'claimed', href: `/a/${slug}` };
    } else if (result.knownSlug) {
      action = { kind: 'claim', href: `/claim/${result.knownSlug}` };
    } else {
      continue;
    }

    const platformNames = [...new Set(
      result.platforms
        .map(link => sources[link.sourceId])
        .filter(source => source && SHOWN_CATEGORIES.has(source.category))
        .map(source => source.name),
    )].slice(0, MAX_PLATFORM_NAMES);

    rows.push({
      id: result.id,
      name: result.name,
      imageUrl: result.imageUrl,
      location: [result.location?.city, result.location?.country ?? result.location?.countryCode]
        .filter(Boolean)
        .join(', '),
      platformNames,
      action,
    });
  }
  return rows;
}
