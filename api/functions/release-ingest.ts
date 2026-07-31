// Turning a fetched Bandcamp /music page into release rows.
//
// The mapping is pure and lives here; the fetching and writing live in
// catalog-artist-background.ts and db.ts. Same split as search-parsers/search-utils versus
// search-sources, and for the same reason: this is the part with decisions in it, so it
// should be testable without a network or a database.

import {
  parseBandcampGridReleases,
  isBandcampChallenge,
  type BandcampGridRelease,
} from './search-parsers';
import {
  deriveStatus,
  mapReleaseType,
  releaseMatchKey,
  uniqueReleaseSlug,
  type ReleaseType,
} from './release-utils';

/** A release ready to be written, with its one known source. */
export interface IngestedRelease {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: ReleaseType;
  /** Null for Bandcamp grid ingest: dates live only on individual release pages. */
  releaseDate: null;
  datePrecision: 'unknown';
  status: 'announced' | 'released';
  artworkUrl: string | null;
  source: {
    platform: 'bandcamp';
    url: string;
    externalId: string | null;
  };
}

export type IngestOutcome =
  | { ok: true; releases: IngestedRelease[] }
  | { ok: false; reason: 'bot_challenge' | 'no_releases' };

/**
 * Map a Bandcamp `/music` page into release rows.
 *
 * `pageUrl` is the URL we actually landed on after redirects, so relative hrefs resolve
 * against the artist's real host (which may be a Bandcamp Pro custom domain).
 *
 * Two failures are reported distinctly rather than both looking like an empty catalog,
 * because conflating them is the single most repeated bug class in this codebase:
 *
 * - `bot_challenge` — Fastly served an interstitial with HTTP 200. The upstream didn't
 *   answer, so nothing may be concluded and nothing should be cached as a negative.
 * - `no_releases` — the page parsed fine and genuinely has no releases (a parked account).
 *
 * A caller that treats these the same records "this artist has no releases" when the truth
 * is "we were blocked".
 */
export function ingestBandcampGrid(html: string, pageUrl: string, now: Date = new Date()): IngestOutcome {
  if (isBandcampChallenge(html)) return { ok: false, reason: 'bot_challenge' };

  const parsed = parseBandcampGridReleases(html);
  if (parsed.length === 0) return { ok: false, reason: 'no_releases' };

  const releases: IngestedRelease[] = [];
  const takenSlugs = new Set<string>();
  const seenKeys = new Set<string>();

  for (const entry of parsed) {
    const url = resolveReleaseUrl(entry, pageUrl);
    if (!url) continue;

    const matchKey = releaseMatchKey(entry.title);
    if (!matchKey) continue; // nothing identifiable to match on

    // Within one page, the same normalized title at the same type is the same release —
    // Bandcamp occasionally lists a release twice (featured plus in-sequence).
    const dedupeKey = `${mapReleaseType(entry.type)}:${matchKey}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    // Slug uniqueness has to account for what this run has already produced, not just what
    // is already stored — two titles can slugify identically in one page.
    const slug = uniqueReleaseSlug(entry.title, takenSlugs);
    takenSlugs.add(slug);

    releases.push({
      title: entry.title,
      slug,
      matchKey,
      releaseType: mapReleaseType(entry.type),
      // The grid carries no dates at all — they exist only on individual release pages, at
      // one extra request each. Left null rather than guessed; a later pass fills them in.
      releaseDate: null,
      datePrecision: 'unknown',
      status: deriveStatus(null, false, now),
      artworkUrl: entry.artworkUrl,
      source: {
        platform: 'bandcamp',
        url,
        externalId: entry.externalId,
      },
    });
  }

  if (releases.length === 0) return { ok: false, reason: 'no_releases' };
  return { ok: true, releases };
}

/**
 * Resolve a grid href, refusing anything that leaves the host we landed on.
 *
 * Same rule as the album-page fetch in check-releases: an href out of fetched markup is
 * untrusted, and a release "source" URL pointing at someone else's domain would be stored
 * and later shown to fans as a place to buy this artist's record.
 */
function resolveReleaseUrl(entry: BandcampGridRelease, pageUrl: string): string | null {
  try {
    const resolved = new URL(entry.href, pageUrl);
    if (resolved.host !== new URL(pageUrl).host) return null;
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * The `/music` URL for an artist's Bandcamp page.
 *
 * Stored links point at all sorts of depths (`/`, `/music`, `/album/x`, with query strings),
 * and the grid only exists at `/music`.
 */
export function bandcampMusicUrl(artistUrl: string): string | null {
  try {
    const u = new URL(artistUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}/music`;
  } catch {
    return null;
  }
}
