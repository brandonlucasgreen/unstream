// Shared shaping for collection reads — used by the owner's view (me-collection) and the
// public page (public-saved-artists), so the two can't drift in what they link to.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { artistSlug, getClient } from './db';

/**
 * Capability tokens for the cover-art proxy.
 *
 * A collection grid renders art as plain <img> tags, and a browser sends no Authorization
 * header on an image subresource — so the proxy could never tell an owner from a stranger and
 * answered a non-public owner's own dashboard with 404s, while re-deriving permission from two
 * database reads on every tile for everyone else. Instead, the endpoints that already decided
 * the viewer may see an item mint its art URL with a token proving that decision, and the proxy
 * verifies the token instead of re-asking the database.
 *
 * Deliberately unexpiring: the token grants exactly one thing — the cover art of one purchased
 * album, an image that is public on Bandcamp anyway — and a stable URL is what lets the CDN
 * keep an image for its full month. It does NOT grant the collection listing, which stays
 * behind its own endpoints' auth and sharing checks. HMAC output truncated to 128 bits, which
 * is a capability, not a stored hash.
 *
 * Uses INTERNAL_FUNCTION_SECRET (already present wherever functions run) with a context prefix
 * so an art token can never pass for an internal-dispatch credential or vice versa. Without the
 * secret the URL is minted bare and the proxy falls back to its database permission check.
 */
export function collectionArtToken(itemId: string): string | null {
  const secret = process.env.INTERNAL_FUNCTION_SECRET;
  if (!secret) return null;
  return createHmac('sha256', secret).update(`collection-art:${itemId}`).digest('hex').slice(0, 32);
}

/** The proxy URL for one item's art, tokened when the secret is available. */
export function collectionArtUrl(itemId: string): string {
  const token = collectionArtToken(itemId);
  return token ? `/api/collection/art/${itemId}?t=${token}` : `/api/collection/art/${itemId}`;
}

/** Constant-time verification, so the token can't be guessed byte by byte. */
export function isValidCollectionArtToken(itemId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = collectionArtToken(itemId);
  if (!expected || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/** Slugs per lookup. A 190-item collection is ~96 artists, so this is one query in practice. */
const ARTIST_LOOKUP_CHUNK = 100;

export interface CollectionRowWithRelease {
  title: string;
  artist_name: string;
  art_url: string | null;
  releases?: { slug: string; artwork_url: string | null; artists: { slug: string } | null } | null;
}

/**
 * Which of these artist names have a page on Unstream, by name → slug.
 *
 * The Bandcamp import stores the artist's name as Bandcamp spells it, not a foreign key, so
 * "does this artist have a page?" is answered by deriving the slug the same way every other
 * writer does — `artistSlug()` — and asking whether that row exists. Deriving it here rather
 * than storing a column keeps a rename in the artists table from stranding a dead link, and
 * avoids a migration on a table whose last one is still waiting to merge.
 *
 * Artists with no page are simply absent from the map: the caller renders their name as
 * plain text rather than a link to a 404.
 */
export async function resolveArtistPages(names: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const client = getClient();
  if (!client || names.length === 0) return resolved;

  // slug → the names that derive it (several spellings can collapse to one slug).
  const namesBySlug = new Map<string, string[]>();
  for (const name of new Set(names)) {
    const slug = artistSlug(name);
    if (!slug) continue;
    const existing = namesBySlug.get(slug);
    if (existing) existing.push(name);
    else namesBySlug.set(slug, [name]);
  }

  const slugs = [...namesBySlug.keys()];
  for (let i = 0; i < slugs.length; i += ARTIST_LOOKUP_CHUNK) {
    const chunk = slugs.slice(i, i + ARTIST_LOOKUP_CHUNK);
    const { data, error } = await client.from('artists').select('slug').in('slug', chunk);
    if (error) {
      // Links are an enhancement; a failed lookup degrades to unlinked names, it doesn't
      // fail the page.
      console.warn('[collection] artist page lookup failed:', error.message);
      continue;
    }
    for (const row of data ?? []) {
      for (const name of namesBySlug.get(row.slug) ?? []) resolved.set(name, row.slug);
    }
  }

  return resolved;
}

/**
 * The release page for a collection item, when we matched it to one. Null otherwise — an
 * unmatched item still renders, it just isn't a link.
 */
export function releaseUrlFor(row: CollectionRowWithRelease): string | null {
  const release = row.releases;
  const artist = release?.artists?.slug;
  return release?.slug && artist ? `/a/${artist}/${release.slug}` : null;
}

/**
 * The artist page for a collection item. Prefers the artist the matched release actually
 * belongs to — that one is a verified relationship — and falls back to the name lookup.
 */
export function artistUrlFor(
  row: CollectionRowWithRelease,
  artistPages: Map<string, string>
): string | null {
  const fromRelease = row.releases?.artists?.slug;
  if (fromRelease) return `/a/${fromRelease}`;
  const bySlug = artistPages.get(row.artist_name);
  return bySlug ? `/a/${bySlug}` : null;
}
