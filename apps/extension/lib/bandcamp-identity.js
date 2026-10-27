// Which Bandcamp account an artist is.
//
// Mirrors api/shared/bandcamp-identity.ts, which the backend and the web app share; the extension
// ships plain JS and can't import it. apps/web/tests/unit/bandcamp-identity-copies.test.ts runs
// both over the same cases, so the copies can't drift apart.
//
// The case behind it: Honeycrush (Brooklyn) and Honey Crush (Orlando) normalize to the same name.
// The popup's MusicBrainz enrichment (/api/search/musicbrainz) describes whoever MusicBrainz
// matched, so without this check Brooklyn's bio and socials were shown — and saved — under
// Orlando's Bandcamp link.

/** The subdomain of a `*.bandcamp.com` URL, or null for anything else (custom domains included). */
export function bandcampSubdomainOf(url) {
  if (!url) return null;
  try {
    const { hostname } = new URL(url);
    if (!hostname.endsWith('.bandcamp.com')) return null;
    return hostname.slice(0, -'.bandcamp.com'.length).toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Both sides name a Bandcamp subdomain and they differ. Absence is not conflict. */
export function bandcampSubdomainConflicts(mbSubdomain, resultUrl) {
  const probed = bandcampSubdomainOf(resultUrl);
  if (!mbSubdomain || !probed) return false;
  return mbSubdomain.toLowerCase() !== probed;
}

/**
 * Whether a card with an artist's name is that artist, given the Bandcamp account we know them
 * by. When several artists share the name (MusicBrainz lists three Paracosms: Los Angeles,
 * Orlando, Sofia), only the same account on both sides counts.
 */
export function nameMatchIsSameArtist(knownSubdomain, nameIsShared, resultUrl) {
  if (bandcampSubdomainConflicts(knownSubdomain, resultUrl)) return false;
  if (!nameIsShared) return true;
  const probed = bandcampSubdomainOf(resultUrl);
  return !!knownSubdomain && probed === knownSubdomain.toLowerCase();
}

/**
 * Whether Phase 2's enrichment describes a different artist from the one the popup shows.
 *
 * The popup shows the first Bandcamp link among the results (renderResults keeps the first link
 * per platform), so that is the account the enrichment is checked against. Older deploys don't
 * send `bandcampSubdomain`, which reads as "no evidence" and changes nothing.
 */
export function enrichmentIsAnotherArtist(results, enrichment) {
  if (!enrichment) return false;
  const shownBandcamp = (results || [])
    .flatMap(r => r.platforms || [])
    .find(p => p.sourceId === 'bandcamp')?.url;
  // `homonyms`: other artists MusicBrainz lists by this name. Older deploys don't send it.
  const nameIsShared = (enrichment.homonyms?.length ?? 0) > 0;
  return !nameMatchIsSameArtist(enrichment.bandcampSubdomain, nameIsShared, shownBandcamp);
}
