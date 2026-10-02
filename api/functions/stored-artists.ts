// Claimed and verified artists we already hold, as result cards.
//
// Used twice per web search: Phase 1 (search-sources.ts) folds them into the live
// results, and /api/search/stored (search-stored.ts) returns them alone, in a few
// hundred milliseconds, so the client can show them while the platform fan-out runs.
// Both read through findStoredArtists, so the early cards are the same cards — same
// ids — that the full results hold.

import { getArtistBySlug, getArtistsBySlugs, artistSlug, findKnownArtistSlugsByName } from './db';
import { makeBio } from '../shared/artist-bio';
import type { AggregatedResult, SearchMode, SourceId } from './search-utils';

/**
 * Stored artists for a query: the claimed profile whose slug is the query, then known
 * artists whose name contains it, in rank order. Never throws — a database failure
 * means no stored cards, not a failed search.
 */
export async function findStoredArtists(normalizedQuery: string, mode: SearchMode): Promise<AggregatedResult[]> {
  // Known artists are looked up two ways, concurrently: claimed profiles by exact slug of the query (covers queries that
  // ARE the artist's name), and any known artist by name-contains — a partial
  // query like "patrick" must surface Patrick Hardy when a past search already
  // resolved and persisted him, and "lightbulbs" must surface the claimed
  // kid-lightbulbs profile instead of a generic scraped card.
  const slug = artistSlug(normalizedQuery);
  const claimedExactPromise: Promise<AggregatedResult | null> = getArtistBySlug(slug)
    .then(dbArtist => dbArtist?.matchConfidence === 'claimed' ? toStoredResult(dbArtist) : null)
    .catch(err => {
      console.error('[DB] Claimed artist lookup failed:', err);
      return null;
    });
  // Name-contains is a fuzzy-only channel: a detection query IS the artist's
  // exact name, so a known artist merely containing it is someone else.
  // Resolved as ONE batched lookup: per-slug getArtistBySlug calls cost 2-3
  // queries each, which made this channel 12-18 reads per fuzzy search. The
  // slugs stay in ranked order — the map lookup preserves it.
  const knownByNamePromise: Promise<AggregatedResult[]> = mode === 'exact'
    ? Promise.resolve([])
    : findKnownArtistSlugsByName(normalizedQuery)
      .then(async slugs => {
        const bySlug = await getArtistsBySlugs(slugs);
        return slugs.map(s => toStoredResult(bySlug.get(s) ?? null));
      })
      .then(list => list.filter((r): r is AggregatedResult => r !== null))
      .catch(err => {
        console.error('[DB] Known artist name search failed:', err);
        return [];
      });

  const [claimedExact, knownByName] = await Promise.all([claimedExactPromise, knownByNamePromise]);
  const stored = claimedExact ? [claimedExact, ...knownByName] : knownByName;
  // The exact-slug and name-contains lookups can both find the same artist.
  return stored.filter((artist, i) => stored.findIndex(a => a.id === artist.id) === i);
}

// Shape a DB artist row into a result card. Claimed rows become full profile
// cards (custom image, /a/ page link); verified rows become plain result cards
// with the links a past search persisted, and carry a knownSlug so the
// frontend can link to the pre-generated /artist/ page. Unverified rows are
// rejected — that confidence level is where junk from name-only matches
// accumulates.
//
// The card's slug is the row's canonical one, never the query-derived slug the
// caller searched under: getArtistBySlug matches tolerantly (query "me:she" →
// slug "me-she" → stored slug "meshe"), and a card linking to the query slug
// 404s at /a/me-she — the 2026-09-19 bug report from me:she.
export function toStoredResult(
  dbArtist: Awaited<ReturnType<typeof getArtistBySlug>>,
): AggregatedResult | null {
  if (!dbArtist) return null;
  const claimed = dbArtist.matchConfidence === 'claimed';
  if (!claimed && dbArtist.matchConfidence !== 'verified') return null;
  const slug = dbArtist.slug;
  return {
    // The known- prefix marks a card served from the DB rather than resolved
    // live; the persist step skips these so re-serving stored data can't
    // refresh updated_at and mask genuine staleness.
    id: claimed ? `claimed-${slug}` : `known-${slug}`,
    name: dbArtist.name,
    type: 'artist' as const,
    imageUrl: dbArtist.profile?.customImageUrl || dbArtist.imageUrl,
    platforms: dbArtist.platforms.map(p => ({
      sourceId: p.sourceId as SourceId,
      url: p.url,
      displayName: p.displayName,
      latestRelease: p.latestRelease,
    })),
    matchConfidence: claimed ? ('claimed' as const) : ('verified' as const),
    ...(claimed ? { claimedSlug: slug } : { knownSlug: slug }),
    ...(dbArtist.location ? { location: dbArtist.location } : {}),
    ...(claimed ? claimedBio(dbArtist.profile, slug) : {}),
  };
}

// A claimed artist's own bio outranks every other source, and their "no bio" switch outranks
// all of them. With no bio written, the card inherits whatever the live search found — see
// mergeStoredArtistsIntoResults.
function claimedBio(
  profile: { bio?: string; showBio?: boolean } | null | undefined,
  slug: string,
): Pick<AggregatedResult, 'bio' | 'bioSuppressed'> {
  if (profile?.showBio === false) return { bioSuppressed: true };
  const bio = makeBio('unstream', profile?.bio, `https://unstream.stream/a/${slug}`);
  return bio ? { bio } : {};
}

