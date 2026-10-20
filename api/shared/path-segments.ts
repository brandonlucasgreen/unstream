// Reading a slug back out of a URL path.
//
// Every route that carries a slug in the path — release feeds, the release page, the v1 artist
// lookup — eventually percent-decodes a segment, and `decodeURIComponent` **throws** on a
// malformed escape: `%zz`, a lone `%`, a truncated `%E0%A4%A`. Unhandled, that turns a crafted
// URL into a 500 from code that never got as far as looking anything up.
//
// A segment that can't be decoded can't be a slug we minted, so the honest answer is "no such
// thing" — null here, and a 404 from the caller — rather than an error.

/**
 * Percent-decode one path segment, or null when it isn't decodable.
 *
 * Returns null rather than throwing or silently handing back the raw text: the raw text would be
 * looked up as if it were a real slug, which is a lookup that can only fail, and on a cached
 * route a failure worth caching is worse than one worth refusing.
 */
export function decodePathSegment(segment: string | undefined | null): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
