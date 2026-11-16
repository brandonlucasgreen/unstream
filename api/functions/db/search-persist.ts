// What a search writes: artist rows, their links and MusicBrainz enrichment, plus the checks
// that decide whether a result is stored at all and which existing artist it belongs to.

import type { SupabaseClient } from '@supabase/supabase-js';
import { artistSlug } from '../../shared/artist-slug';
import { normalizeUrlForMatch, urlMatchPrefilter } from '../search-utils';
import { isNonArtistSlug } from '../../lib/non-artist-names';
import { isExcludedArtistSlug } from '../../lib/excluded-artists';
import { getClient } from './client';

// Determine if a platform URL is a direct link (not a search URL).
// Exported so scripts/backfill-published-artist-rows.ts stores exactly what a search would store.
//
// This is not only a label: persistSearchResults filters on it, so it decides which links get a
// row at all. `bandcamp.com/search` is listed because it did not used to be — the search-link
// fallback that produced it is gone now, but 189 rows reached the database through this gate
// first, and the crawler then treated every one of them as an artist page (#407).
//
// `subvert.fm/discover` is the same mistake caught later: Subvert is `searchOnly: true` in
// sources.ts and its `searchUrlTemplate` IS that discover URL, so every search-discovered Subvert
// "link" was the search box — 321 of the 349 stored. The other 28 are real `subvert.fm/<handle>`
// pages that artists added themselves, which is why this matches the /discover path and not the
// host: excluding the platform would delete those.
export function isDirectLink(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    !lower.includes('duckduckgo.com') &&
    !lower.includes('google.com/search') &&
    !lower.includes('bandcamp.com/search') &&
    !lower.includes('subvert.fm/discover') &&
    !lower.includes('searchstyle=search') &&
    !lower.includes('explore-creators')
  );
}

// Platforms that are manual search links, not real artist presences.
// Exported alongside isDirectLink for the same reason — see above.
export const EXCLUDED_PLATFORMS = new Set(['buymeacoffee', 'kofi', 'ampwall']);

/**
 * How often a search is allowed to touch an artist row that hasn't actually changed.
 *
 * `persistSearchResults` used to upsert the `artists` row on *every* search, always stamping
 * `updated_at` — so searching an artist we already knew perfectly still rewrote the row. Postgres
 * has no in-place update: each write is a new tuple version plus an entry in all five of this
 * table's indexes, one of which is a GIN trigram index on `name`. It was the hottest path in the
 * product doing pure write churn, and a contributor to the Disk IO Budget alert.
 *
 * **It cannot simply be skipped when nothing changed, though**, because `updated_at` on this table
 * does not mean "when the data changed" — `getArtistBySlug` reads it as "when we last verified
 * this artist against live sources" and refuses the row once it passes FRESHNESS_TTL_MS. Stop
 * advancing it and stored cards silently expire, so every search re-runs the full live pipeline:
 * cheaper on Postgres, much more expensive everywhere else, and a behaviour change nobody asked
 * for. (search-sources.ts makes the same point from the other direction: DB-served cards are
 * deliberately excluded from persist so re-serving stored data can't refresh `updated_at` and
 * mask genuine staleness.)
 *
 * So the write is *throttled*, not removed: an unchanged row is refreshed at most once an hour.
 * Well inside the 24-hour freshness window, so no row can expire because of this, while N searches
 * for the same artist within the hour collapse into one write instead of N.
 *
 * Keep this comfortably below FRESHNESS_TTL_MS. Raising it towards 24 hours would start letting
 * rows expire between refreshes.
 */
const PERSIST_REFRESH_FLOOR_MS = 60 * 60 * 1000;

/**
 * Whether a search needs to write to an artist row it already found.
 *
 * True when the row would actually change, or when it is due a freshness refresh. False means the
 * write is pure churn and is skipped.
 */
function artistNeedsRefresh(
  existing: { name: string | null; image_url: string | null; match_confidence: string | null; updated_at: string | null },
  name: string,
  imageUrl: string | null,
  matchConfidence: string
): boolean {
  if (existing.name !== name) return true;
  if (existing.image_url !== imageUrl) return true;
  if (existing.match_confidence !== matchConfidence) return true;

  // An unparseable or missing timestamp is treated as due, so a bad value can't pin a row
  // permanently unrefreshed — the failure mode has to be "one extra write", never "never again".
  if (!existing.updated_at) return true;
  const updatedAt = new Date(existing.updated_at).getTime();
  if (Number.isNaN(updatedAt)) return true;

  return Date.now() - updatedAt > PERSIST_REFRESH_FLOOR_MS;
}

/**
 * Platforms whose URL identifies the artist's own catalogue, rather than a handle.
 *
 * Used as the evidence that an incoming search result is an artist we already have under a different
 * spelling. Socials and patronage are **deliberately excluded**, and that exclusion is the whole
 * reason this works. Measured across all 27 duplicate pairs on 2026-08-03:
 *
 *   - With socials included, `Honeycrush` and `Honey Crush` share `patreon.com/honeycrush`, and
 *     `Boto` and `Błoto` share `facebook.com/blotoquartet` — so both pairs look like one artist.
 *     They are not: those links were mis-attached by the homonym bug fixed in July, and using them
 *     as evidence would re-fuse exactly what that fix separated.
 *   - With only these platforms, both drop to "no evidence", `Tigercub`/`Tiger Cub` stays separate,
 *     and the genuine same-artist pairs still resolve — `Big Thief`/`Bigthief`,
 *     `Creepy Nuts`/`Creepynuts`, `Cry Wolf`/`Crywolf`, `I.O.I`/`Ioi`, `Rue Oberkampf`/`Rueoberkampf`
 *     all via a shared Discogs artist id or Bandcamp subdomain.
 *
 * **Every platform here must be inside the predicate of `idx_artist_links_identity_url_trgm`**
 * (migration 20261018120000). That partial index is what keeps the `url ILIKE '%…%'` lookup below
 * off a sequential scan of `artist_links`, and Postgres uses it only while every platform queried
 * here is inside its predicate. Add a platform here without a migration and the lookup still
 * works, just as a full scan again.
 *
 * The predicate may name more platforms than this list, and does: `nina` stayed in it when Nina
 * Protocol shut down (July 2026). Postgres still uses the index for a subset (checked on PGlite
 * with the real migration), and no stored link carried `nina`, so rebuilding the index to drop it
 * would have bought nothing.
 *
 * **Faircamp is not here, and it stays in the index predicate the same way.** A Faircamp address is
 * a whole site, and many sites carry several artists — 50 of the 103 in the webring directory on
 * 2026-11-05. Search attaches the site to every artist it lists, so the site says nothing about
 * which of them a card is: `cult.kidlightbulbs.com` lists Kid Lightbulbs and Brandon Lucas Green,
 * and while Faircamp was here, every Brandon Lucas Green card was taken for the claimed Kid
 * Lightbulbs row and never stored, leaving its page and its Claim link pointing at nothing. The
 * catalogue makes the same distinction: it takes from a Faircamp site only the releases credited
 * to the artist by name.
 */
const IDENTITY_PLATFORMS = new Set([
  'bandcamp', 'mirlo', 'jamcoop', 'discogs', 'beatport', 'bandwagon', 'subvert', 'even',
]);

/** At most this many URLs are checked per artist, to bound the query. Ordered by trustworthiness. */
const IDENTITY_LOOKUP_LIMIT = 3;

/**
 * The slug of an existing artist who already owns one of these platform URLs, or null.
 *
 * This is what stops a second row being created for an artist a different source spells differently.
 * `artistSlug` derives the slug from whichever name won aggregation, and that varies between
 * searches with which platforms answered — so "Big Thief" and "Bigthief" became two rows, two pages
 * and two half-populated link sets. Matching on a shared catalogue URL says "this is the artist we
 * already have" without ever claiming two similarly-named artists are one.
 *
 * Returns null when **nothing** matches (a genuinely new artist) and also when **more than one**
 * artist matches. Two artists sharing an identity URL means the data is already wrong somewhere;
 * quietly picking one would attach this result to a coin-flip. Falling through creates the row under
 * its own slug, which is today's behaviour.
 *
 * Called only when no row exists at the computed slug — i.e. only when a new row would otherwise be
 * minted. `persistSearchResults` is awaited before the search response is sent, so an already-known
 * artist must not pay for this.
 */
async function findArtistSlugByIdentityUrl(
  client: SupabaseClient,
  platforms: { sourceId: string; url: string }[],
): Promise<string | null> {
  const urls = platforms
    .filter(p => IDENTITY_PLATFORMS.has(p.sourceId))
    .slice(0, IDENTITY_LOOKUP_LIMIT);
  if (urls.length === 0) return null;

  // Coarse prefilter on host+path, so a row stored as http://, with a www. prefix, or with a
  // trailing slash is still a candidate — measured: of 4,782 stored identity links, 2,804 carry
  // www. and 581 a trailing slash, so exact matching would miss a large share. Same escaping as
  // deleteStoredLinksForUrl: ilike treats % and _ as wildcards and a URL may contain either.
  const filters = urls.map(
    p => `url.ilike.%${urlMatchPrefilter(p.url).replace(/[%_\\]/g, m => `\\${m}`)}%`,
  );

  try {
    const { data, error } = await client
      .from('artist_links')
      .select('artist_id, url, artists!inner(slug)')
      .in('platform', [...IDENTITY_PLATFORMS])
      .or(filters.join(','));

    if (error) {
      console.error('[DB] identity-url lookup failed:', error.message);
      return null;
    }

    // The prefilter is a substring match, so confirm each hit on the normalized URL before trusting
    // it — otherwise `discogs.com/artist/123` would match `discogs.com/artist/1234`.
    const wanted = new Set(urls.map(p => normalizeUrlForMatch(p.url)));
    const slugs = new Set<string>();
    for (const row of (data ?? []) as { url: string; artists?: { slug?: string } }[]) {
      if (!wanted.has(normalizeUrlForMatch(row.url))) continue;
      if (row.artists?.slug) slugs.add(row.artists.slug);
    }

    if (slugs.size !== 1) return null;
    return [...slugs][0];
  } catch (error) {
    console.error('[DB] findArtistSlugByIdentityUrl error:', error);
    return null;
  }
}

/**
 * The slug of an artist who already holds this Bandcamp URL, or null.
 *
 * The single-URL case of `findArtistSlugByIdentityUrl`, exported for the collection matcher.
 * An artist discovered from a fan's Bandcamp collection is often one we already hold under a
 * different spelling — the collection carries Bandcamp's spelling, the stored row carries
 * whichever name won aggregation — and creating a second row would split their releases across
 * two pages exactly as "Big Thief" / "Bigthief" once did.
 */
export async function findArtistSlugByBandcampUrl(url: string): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  return findArtistSlugByIdentityUrl(client, [{ sourceId: 'bandcamp', url }]);
}

/**
 * Persist artist search results to the database.
 * Only persists artist-type results. Runs as fire-and-forget after search.
 */
/** A link row as persistSearchResults builds it, before it goes to Postgres. */
interface LinkRowToWrite {
  artist_id: string;
  platform: string;
  url: string;
  source: string;
  is_direct: boolean;
  latest_release: unknown;
  display_order: number;
}

/**
 * Key-order-independent comparison for the one jsonb column involved (`latest_release`).
 *
 * We build the object in JS and compare it against what PostgREST hands back, and nothing
 * guarantees the two serialize their keys in the same order — so a plain JSON.stringify compare
 * would report "changed" constantly and defeat the whole point.
 *
 * Deliberately biased: anything this can't confidently prove identical is reported as *different*.
 * A false "different" costs one unnecessary write; a false "same" would skip a real update and
 * leave stale data on an artist's page, which is the far worse failure.
 */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJsonValue(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every(k => sameJsonValue(aObj[k], bObj[k]));
}

/**
 * Narrow a set of link rows to the ones that would actually change something.
 *
 * One indexed read replaces up to N row rewrites. Returns every row unchanged if the read fails —
 * failing towards "write it" keeps the old behaviour rather than silently dropping a real update
 * because a lookup blipped.
 */
async function filterUnchangedLinks(
  client: SupabaseClient,
  artistId: string,
  rows: LinkRowToWrite[]
): Promise<LinkRowToWrite[]> {
  if (rows.length === 0) return rows;

  const { data, error } = await client
    .from('artist_links')
    .select('platform, url, source, is_direct, latest_release, display_order')
    .eq('artist_id', artistId);

  if (error) {
    console.error('[DB] filterUnchangedLinks read failed, writing all links:', error.message);
    return rows;
  }

  type StoredLink = Omit<LinkRowToWrite, 'artist_id'>;
  const stored = new Map<string, StoredLink>();
  for (const row of (data as StoredLink[]) || []) stored.set(row.platform, row);

  return rows.filter(row => {
    const prior = stored.get(row.platform);
    if (!prior) return true;
    return !(
      prior.url === row.url &&
      prior.source === row.source &&
      prior.is_direct === row.is_direct &&
      prior.display_order === row.display_order &&
      sameJsonValue(prior.latest_release, row.latest_release)
    );
  });
}

/**
 * The fields persistSearchResults reads from a search result card. Deliberately
 * structural: its one production caller passes AggregatedResult (search-utils)
 * cards, not ArtistResult rows, and these are the only fields the write path
 * touches — it derives its own slug from `name` rather than trusting a card's.
 */
export interface PersistableResult {
  type: 'artist' | 'album' | 'track';
  name: string;
  imageUrl?: string;
  matchConfidence?: string;
  platforms: { sourceId: string; url: string; latestRelease?: unknown }[];
  /**
   * The slug the search decided this card is stored under (`recordSlugs`): usually the name's, but
   * an address that tells same-name artists apart when several share it. Null: the card gets no
   * row. Absent (callers other than search): derived from the name, as before.
   */
  slug?: string | null;
  /** Where the artist is, written only when their row is first created. */
  location?: { city?: string; country?: string; countryCode?: string };
}

/**
 * Why `persistSearchResults` will write no row for this card, or null if it will — for the reasons
 * that can be decided from the card alone, without the database.
 *
 * Search hands out a card's page and Claim address (`attachArtistPageSlugs`) before the write
 * happens, in a background function. It asks this first, so a card the write will skip isn't sent
 * to an address that will never exist: an artist page that 404s and a claim that fails at "Artist
 * not found". The write skips for the same reasons, through the same function, so the two can't
 * drift.
 */
export function searchPersistSkipReason(
  result: Pick<PersistableResult, 'name' | 'platforms'>,
): string | null {
  // Only artists with at least one real, direct link are stored; manual search links and the
  // platforms in EXCLUDED_PLATFORMS are not a presence.
  if (!result.platforms.some(p => !EXCLUDED_PLATFORMS.has(p.sourceId) && isDirectLink(p.url))) {
    return 'no direct link';
  }

  // Keyed by the name's slug, not the card's address: `xparacosm` must not let an excluded or
  // non-artist name through.
  const nameSlug = artistSlug(result.name);

  // Software products, brands and TV shows can carry a MusicBrainz entry and a Beatport listing,
  // and the pipeline's default verdict is 'verified', so without this gate one search mints them a
  // permanent /artist/ page. The search response may still show what it found — it is the durable
  // row that must not exist. See api/lib/non-artist-names.ts.
  if (isNonArtistSlug(nameSlug)) return `non-artist (${nameSlug})`;

  // Acts excluded on ethical grounds — a separate, editorial list. See api/lib/excluded-artists.ts.
  if (isExcludedArtistSlug(nameSlug)) return `excluded artist (${nameSlug})`;

  return null;
}

/**
 * Persist the artists and links a search turned up.
 *
 * **This does not request release cataloging, deliberately.** It used to: every search handed
 * every Bandcamp-linked artist in its results to `requestArtistCatalog(..., 'searched')`, which
 * made an unauthenticated, traffic-driven path the largest producer of database writes on the
 * site — up to `CATALOG_HOURLY_CAP.searched` (60) full first-time crawls an hour, against the
 * scheduled sweep's 100 a *day*. Each of those crawls inserts a row per release, a row per
 * release source and a row or three per offer, into three six-index tables, and then re-reads
 * every one of them on the periodic detail refresh (DETAIL_REFRESH_DAYS). That is what exhausted the Supabase disk I/O
 * budget; see docs/specs/supabase-disk-io-investigation.md for the numbers and the SQL that
 * confirms it.
 *
 * Cataloging still happens, just from bounded triggers: a save, an artist's own button, the
 * admin command, a Bandcamp collection import, and the twice-daily sweep — whose pool is every
 * artist with a catalogue-able link, so a searched artist is still reached, within a couple of
 * months rather than within a minute. The cost of that trade is coverage latency on a brand-new
 * artist page, not lost coverage.
 *
 * Do not reintroduce a search-time trigger without a per-run budget that is measured against
 * the disk I/O headroom, not just against what Bandcamp will tolerate.
 */
export async function persistSearchResults(results: PersistableResult[]): Promise<void> {
  const client = getClient();
  if (!client) return;

  // Search does NOT trigger release cataloging. See the note above persistSearchResults.

  // Search hands each card the slug it decided on (`recordSlugs`), which already gives same-name
  // artists addresses of their own. Two cards that still arrive at one slug are written by
  // neither: each would write its links over the other's and leave one page describing both,
  // which is how /a/paracosm came to hold a Sofia band's Bandcamp beside an Orlando band's site.
  const slugOf = (result: PersistableResult) => result.slug === undefined ? artistSlug(result.name) : result.slug;
  const slugCounts = new Map<string, number>();
  for (const result of results) {
    if (result.type !== 'artist') continue;
    const slug = slugOf(result);
    if (slug) slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
  }

  // Normally runs in persist-search-results-background, after the search has responded, but
  // request-persist.ts falls back to running it inline before the response, so wall-clock time
  // still matters: artists persist concurrently, and each artist's links go up in one bulk
  // upsert instead of one round-trip per link.
  await Promise.all(results.map(async result => {
    if (result.type !== 'artist') return;

    const skipReason = searchPersistSkipReason(result);
    if (skipReason) {
      console.log(`[DB] Skipping persist for "${result.name}": ${skipReason}`);
      return;
    }

    // Excluded platforms and manual search links are not written as links.
    const validPlatforms = result.platforms.filter(
      p => !EXCLUDED_PLATFORMS.has(p.sourceId) && isDirectLink(p.url)
    );

    const decided = slugOf(result);
    if (decided === null) {
      console.log(`[DB] Skipping persist for "${result.name}": shares its name and has nothing to tell it apart`);
      return;
    }
    let slug = decided;

    if ((slugCounts.get(slug) ?? 0) > 1) {
      console.log(`[DB] Skipping persist for "${result.name}": ${slugCounts.get(slug)} artists at "${slug}" in one search`);
      return;
    }

    try {
      // Check if this artist is already claimed — never overwrite claimed status.
      // `name`, `image_url` and `updated_at` come back too, so the write below can be skipped
      // when it would change nothing. See PERSIST_REFRESH_FLOOR_MS.
      const { data: existing } = await client
        .from('artists')
        .select('id, name, image_url, match_confidence, updated_at')
        .eq('slug', slug)
        .single();

      // No row at this slug, so a new one is about to be created. Before doing that, check whether
      // we already hold this artist under a different spelling — different sources spell one artist
      // differently ("Big Thief" vs "Bigthief"), the slug follows whichever name won aggregation, and
      // the result was two rows and two half-populated pages. Only reached on the create path, so a
      // known artist pays nothing for it.
      if (!existing) {
        const owned = await findArtistSlugByIdentityUrl(client, validPlatforms);
        if (owned && owned !== slug) {
          console.log(`[DB] "${result.name}" already stored as "${owned}" — reusing that row instead of creating ${slug}`);
          slug = owned;
          // Re-check the claimed guard against the row we are now writing to: that row may be a
          // claimed profile, and skipping this would let a stranger's search overwrite it.
          const { data: owner } = await client
            .from('artists')
            .select('match_confidence')
            .eq('slug', slug)
            .single();
          if (owner?.match_confidence === 'claimed') {
            console.log(`[DB] Skipping persist for claimed artist "${result.name}" (matched via ${slug})`);
            return;
          }
        }
      }

      if (existing?.match_confidence === 'claimed') {
        console.log(`[DB] Skipping persist for claimed artist "${result.name}"`);
        return;
      }

      // Upsert artist, keeping the pipeline's verdict. This used to hardcode
      // 'unverified', which made the stored confidence meaningless — every
      // non-claimed row was 'unverified' forever, so quality filters over the
      // table (partial-name discovery, typeahead) could never distinguish a
      // release-corroborated artist from name-match junk. Rows refresh on
      // every search, so the stored verdict tracks the latest pipeline run.
      const matchConfidence = result.matchConfidence === 'verified' ? 'verified' : 'unverified';
      const imageUrl = result.imageUrl || null;

      let artistId: string;

      if (existing && !artistNeedsRefresh(existing, result.name, imageUrl, matchConfidence)) {
        // Nothing to say about this artist that the row doesn't already say, and it was
        // refreshed recently enough that `updated_at` doesn't need moving. Skipping the write
        // is the point: see artistNeedsRefresh.
        artistId = existing.id;
      } else {
        const { data: artist, error: artistError } = await client
          .from('artists')
          .upsert(
            {
              slug,
              name: result.name,
              image_url: imageUrl,
              match_confidence: matchConfidence,
              source: 'auto',
              updated_at: new Date().toISOString(),
              // Only on a row this search is creating: an existing row's location is
              // persistEnrichment's to keep, and `paracosm-orlando` should say Orlando from the start.
              ...(!existing && slug === decided && result.location?.city ? {
                city: result.location.city,
                country: result.location.country ?? null,
                country_code: result.location.countryCode ?? null,
              } : {}),
            },
            { onConflict: 'slug' }
          )
          .select('id')
          .single();

        if (artistError || !artist) {
          console.error(`[DB] Failed to upsert artist "${result.name}":`, artistError);
          return;
        }

        artistId = artist.id;
      }

      // Bulk-upsert links (only valid platforms) in a single request.
      // Deduped by platform (last wins, matching the old one-at-a-time loop) —
      // Postgres rejects a bulk upsert that touches the same conflict key twice.
      const linkRowsByPlatform = new Map(validPlatforms.map((platform, index) => [
        platform.sourceId,
        {
          artist_id: artistId,
          platform: platform.sourceId,
          url: platform.url,
          source: 'search',
          is_direct: true,
          latest_release: platform.latestRelease || null,
          display_order: index,
        },
      ]));
      const linkRows = [...linkRowsByPlatform.values()];

      // Only write links that would actually differ from what's stored.
      //
      // This bulk upsert used to run on every search, rewriting every one of an artist's link
      // rows whether or not anything had moved — and platform URLs almost never move. That is the
      // larger half of the churn described on PERSIST_REFRESH_FLOOR_MS, because it is N rows per
      // artist per search rather than one.
      //
      // Unlike `artists.updated_at`, nothing reads `artist_links.updated_at` as a freshness
      // signal, so an unchanged link row genuinely has no reason to be touched and there is no
      // throttle here — just a comparison. The read that makes the comparison possible is one
      // indexed lookup on `idx_artist_links_artist_id`, which is far cheaper than the writes it
      // avoids: a read costs no WAL, no index maintenance and no dead tuples.
      const changedLinkRows = existing
        ? await filterUnchangedLinks(client, artistId, linkRows)
        : linkRows;

      if (changedLinkRows.length > 0) {
        const { error: linkError } = await client
          .from('artist_links')
          .upsert(changedLinkRows, { onConflict: 'artist_id,platform' });

        if (linkError) {
          console.error(`[DB] Failed to upsert links for "${result.name}":`, linkError);
        }
      }

      console.log(
        `[DB] Persisted "${result.name}": ${changedLinkRows.length} of ${linkRows.length} links written`
      );
    } catch (error) {
      console.error(`[DB] Error persisting "${result.name}":`, error);
    }
  }));
}

/**
 * Persist MusicBrainz enrichment data for an artist.
 *
 * Writes only what differs from what is stored. This used to upsert every enrichment link, one
 * round trip each, and then stamp `artists.last_enriched_at` — on every Phase 2 call, cache hit or
 * not, whether or not a single URL had changed. Postgres has no in-place update, so each of those
 * was a new tuple version plus index entries (six on `artists`, one of them the trigram GIN on
 * `name`) plus a dead tuple for autovacuum. It was the one search-time writer that the round-1
 * disk I/O work (#463) left un-diffed; see docs/specs/supabase-disk-io-investigation.md, round 4.
 *
 * `last_enriched_at` is no longer written at all. Nothing reads it — it was set in exactly one
 * place and consulted nowhere — and the write dragged the whole `artists` row through the
 * `updated_at` trigger for nothing. The column stays (dropping it is a migration for no gain);
 * it just stops moving.
 */
export async function persistEnrichment(
  artistName: string,
  mbData: {
    officialUrl: string | null;
    discogsUrl: string | null;
    hasPre2005Release: boolean;
    socialLinks: { platform: string; url: string }[];
    discoveredPlatforms?: { platform: string; url: string }[];
    location?: { city?: string; country?: string; countryCode?: string };
  }
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const slug = artistSlug(artistName);

  try {
    // Find the artist. Location columns come back too so the location write can be skipped when
    // it would change nothing.
    const { data: artist, error: findError } = await client
      .from('artists')
      .select('id, match_confidence, city, country, country_code')
      .eq('slug', slug)
      .single();

    if (findError || !artist) {
      // Artist not in DB yet (search hasn't been persisted). That's OK.
      return;
    }

    // Never overwrite links for claimed artists — they manage their own links
    if (artist.match_confidence === 'claimed') {
      console.log('[DB] Skipping enrichment for a claimed artist');
      return;
    }

    const artistId = artist.id;

    // Build enrichment links
    const enrichmentLinks: { platform: string; url: string }[] = [];

    if (mbData.officialUrl) {
      enrichmentLinks.push({ platform: 'officialsite', url: mbData.officialUrl });
    }
    if (mbData.discogsUrl) {
      enrichmentLinks.push({ platform: 'discogs', url: mbData.discogsUrl });
    }
    if (mbData.hasPre2005Release) {
      enrichmentLinks.push({
        platform: 'hoopla',
        url: `https://www.hoopladigital.com/search?q=${encodeURIComponent(artistName)}&type=music`,
      });
      enrichmentLinks.push({
        platform: 'freegal',
        url: `https://www.freegalmusic.com/search-page/${encodeURIComponent(artistName)}`,
      });
    }

    for (const social of mbData.socialLinks || []) {
      enrichmentLinks.push({ platform: social.platform, url: social.url });
    }
    for (const discovered of mbData.discoveredPlatforms || []) {
      enrichmentLinks.push({ platform: discovered.platform, url: discovered.url });
    }

    // Deduped by platform (last wins) — Postgres rejects a bulk upsert that touches the same
    // conflict key twice. Excluded platforms and non-direct URLs are dropped here, so every row
    // that survives is direct.
    const wanted = new Map<string, string>();
    for (const link of enrichmentLinks) {
      if (EXCLUDED_PLATFORMS.has(link.platform) || !isDirectLink(link.url)) continue;
      wanted.set(link.platform, link.url);
    }

    // One read of what's stored, then write only the platforms whose URL differs.
    //
    // Only the URL is compared, deliberately. `source` records which pipeline wrote the row
    // ('search' or 'musicbrainz'), and both pipelines can legitimately hold the same URL for the
    // same platform — comparing it would have the two flip the row back and forth on alternate
    // requests forever, which is the churn this function is trying to stop. A stored URL that
    // already matches is left exactly as it is, whoever wrote it.
    const changedRows = await filterUnchangedEnrichmentLinks(client, artistId, wanted);

    if (changedRows.length > 0) {
      const { error } = await client
        .from('artist_links')
        .upsert(changedRows, { onConflict: 'artist_id,platform' });

      if (error) {
        console.error('[DB] Failed to upsert enrichment links:', error);
      }
    }

    // Location: only when discovered, and only when it differs from what's stored.
    let locationWritten = false;
    if (mbData.location) {
      const patch = {
        city: mbData.location.city ?? null,
        country: mbData.location.country ?? null,
        country_code: mbData.location.countryCode ?? null,
      };
      const stored = artist as { city: string | null; country: string | null; country_code: string | null };
      if (
        stored.city !== patch.city ||
        stored.country !== patch.country ||
        stored.country_code !== patch.country_code
      ) {
        const { error } = await client.from('artists').update(patch).eq('id', artistId);
        if (error) {
          console.error('[DB] Failed to update artist location:', error);
        } else {
          locationWritten = true;
        }
      }
    }

    const locationLog = locationWritten ? ' + location' : '';
    console.log(
      `[DB] Enriched: ${changedRows.length} of ${wanted.size} MusicBrainz links written${locationLog}`
    );
  } catch (error) {
    console.error('[DB] Error enriching artist:', error);
  }
}

/**
 * The enrichment link rows whose URL differs from what is stored for that platform.
 *
 * Read failure writes everything: an extra write is the cheap failure mode, a link silently
 * never stored is the expensive one. Same rule as `filterUnchangedLinks`.
 */
async function filterUnchangedEnrichmentLinks(
  client: SupabaseClient,
  artistId: string,
  wanted: Map<string, string>
): Promise<{ artist_id: string; platform: string; url: string; source: string; is_direct: boolean }[]> {
  const toRow = (platform: string, url: string) => ({
    artist_id: artistId,
    platform,
    url,
    source: 'musicbrainz',
    is_direct: true,
  });

  if (wanted.size === 0) return [];

  const { data, error } = await client
    .from('artist_links')
    .select('platform, url')
    .eq('artist_id', artistId);

  if (error) {
    console.error('[DB] filterUnchangedEnrichmentLinks read failed, writing all links:', error.message);
    return [...wanted].map(([platform, url]) => toRow(platform, url));
  }

  const stored = new Map<string, string>();
  for (const row of (data as { platform: string; url: string }[]) || []) stored.set(row.platform, row.url);

  return [...wanted]
    .filter(([platform, url]) => stored.get(platform) !== url)
    .map(([platform, url]) => toRow(platform, url));
}
