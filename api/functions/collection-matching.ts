// Turning collection items into linked releases.
//
// A Bandcamp import writes what Bandcamp tells us — a title, an artist name, an album id — and
// attaches an Unstream release only when we already hold one. Most of a real collection is
// therefore unlinked: the fan bought from artists nobody has ever searched, so there is no
// `artists` row, no catalogue, and no release page to point at. On a public profile that renders
// as a wall of plain text, which is the opposite of the point of the page.
//
// **Linking straight out to Bandcamp instead is not available.** Bandcamp's Subsonic API returns
// no URLs at all — id, name, artist, coverArt, year, genre, created is the whole album payload
// (see bandcamp-subsonic.ts) — so there is no source link to fall back to, and deriving one from
// the title would mint URLs that 404 whenever a slug isn't the obvious one. What the import does
// give us is a trustworthy artist name, and that is enough to run the same discovery the rest of
// the product runs.
//
// Two halves, deliberately apart because they become possible at different moments:
//
//   resolveCollectionArtists()      After an import. Finds the artists we don't hold yet, probes
//                                   for their Bandcamp page, stores them, and asks for their
//                                   catalogues. Costs one probe per name we've never seen.
//   linkCollectionItemsForArtist()  After a catalogue is built. Attaches the releases that pass
//                                   just created to the items that were waiting for them. Pure
//                                   database work, called from every catalogue run from now on —
//                                   so an item that can be linked eventually is, whatever caused
//                                   the crawl.
//
// Neither half guesses. An item is linked only when its title matches a release exactly on
// `releases.match_key`, because a collection page asserts that a specific person bought a
// specific record — the same reasoning that makes the import's matching deliberately
// conservative, and the reason a near-miss stays unlinked rather than becoming a wrong claim.

import type { SupabaseClient } from '@supabase/supabase-js';
import { findBandcampArtist } from '../search/bandcamp-probe';
import {
  artistSlug,
  findArtistSlugByBandcampUrl,
  getClient,
  readAllPages,
} from './db';
import { releaseMatchKey } from './release-utils';
import { requestArtistCatalog } from './request-catalog';
import { isNonArtistSlug } from '../lib/non-artist-names';
import { isExcludedArtistSlug } from '../lib/excluded-artists';

/** Item ids per update request. Realistically a handful; this only bounds the URL length. */
const UPDATE_CHUNK = 100;

/**
 * Artist names one resolve pass will look up.
 *
 * Each unknown name costs one probe round (up to three requests, cached forever afterwards
 * including the negatives), so this is the pass's whole crawl cost. A large collection is a few
 * hundred artists, and 100 covers most of one in a single run at roughly two minutes of paced
 * requests — comfortably inside a background function's 15-minute ceiling. Anything past it is
 * reported, never dropped silently, and the next re-sync starts where this stopped.
 */
const MAX_ARTISTS_PER_RESOLVE = 100;

/**
 * Artists this pass asks to be catalogued directly.
 *
 * **Must stay equal to MAX_ARTISTS_PER_REQUEST in request-catalog.ts**, which slices anything
 * longer — asking for 100 would silently crawl 25. Everything beyond this is left to the
 * six-hourly sweep rather than fanned out across four concurrent invocations: a newly stored
 * artist has a Bandcamp link, which puts them in `getStaleCatalogCandidates`' pool as
 * never-catalogued, and that tier is ranked above the refresh tail. So the rest arrive within a
 * day or so, at the sweep's pace rather than all at once, and no one has to press anything.
 */
const MAX_CATALOG_REQUESTS = 25;

/** Pause between probe rounds. One artist per second, matching the crawler's own spacing. */
const DELAY_BETWEEN_PROBES_MS = 1_000;

/**
 * Stop starting new probes after this long, however many names are left.
 *
 * The count above bounds the ordinary case; this bounds the bad one. A probe round is normally
 * 270-980ms but may spend its full 5-second budget, so 100 names have a worst case near ten
 * minutes — and this pass runs *after* an import that has already spent some of the same
 * invocation. Stopping early is a deferral, reported like any other, where being killed at
 * Netlify's ceiling would lose the summary and with it any sign of what happened.
 */
const RESOLVE_DEADLINE_MS = 6 * 60_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** `ilike` treats % and _ as wildcards, and both turn up in real artist names. */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, match => `\\${match}`);
}

/**
 * Attach an artist's releases to collection items that were imported before those releases
 * existed.
 *
 * Called at the end of every catalogue run, which is the moment the releases become linkable —
 * the import that created these items ran days earlier, when this artist had no catalogue to
 * match against. It re-runs for every later catalogue pass too, so a release added to a
 * discography later still finds the fans who already own it.
 *
 * Matched on `releases.match_key` via `releaseMatchKey`, the function that produced the column.
 * Titles are compared against the artist's own catalogue only, so the exactness is a guard
 * against linking a fan to the wrong record, not against a different artist's album.
 *
 * Returns how many items were linked. Never throws: a fan's collection page not gaining a link
 * is not a reason to fail an artist's catalogue run.
 */
export async function linkCollectionItemsForArtist(
  artistId: string,
  artistName: string
): Promise<number> {
  const client = getClient();
  if (!client) return 0;

  try {
    const { data: releaseRows, error: releaseError } = await client
      .from('releases')
      .select('id, match_key')
      .eq('artist_id', artistId)
      .eq('is_hidden', false);

    if (releaseError) {
      console.error('[collection-match] release read failed:', releaseError.message);
      return 0;
    }

    const releaseByKey = new Map<string, string>();
    for (const row of (releaseRows ?? []) as { id: string; match_key: string | null }[]) {
      if (row.match_key) releaseByKey.set(row.match_key, row.id);
    }
    if (releaseByKey.size === 0) return 0;

    // Every user's unlinked items, not just one person's: a catalogue is built once and whoever
    // owns that record benefits. Paged because `collection_items` holds a row per purchase per
    // fan and PostgREST truncates a plain select at 1,000 rows without saying so.
    //
    // The probe is an equality on `artist_slug`, served by its partial index — this runs at the
    // end of every catalogue pass (100+/day) and almost always finds nothing, and as an
    // `artist_name ILIKE` it was a full scan of every user's items each time. Matching on the
    // slug rather than the name is also deliberately accent-insensitive, the same equivalence
    // resolveCollectionArtists already applies when it dedupes names ("Björk" and "Bjork" are
    // one artist to it, so they should be one artist here).
    const slug = artistSlug(artistName);
    if (!slug) return 0;
    const itemRead = await readAllPages<{ id: string; title: string }>(
      (from, to) =>
        client
          .from('collection_items')
          .select('id, title')
          .is('release_id', null)
          .eq('artist_slug', slug)
          .order('id')
          .range(from, to),
      'collection_items (awaiting a release)'
    );
    if (!itemRead.ok) return 0;

    // Rows imported before artist_slug existed have it NULL until their owner's next re-sync
    // backfills them (the sync's diff writes the new column once). This fallback keeps those
    // items linkable in the meantime; it's a scan, but only of a population that shrinks to
    // zero — delete it once `count(*) WHERE artist_slug IS NULL` reads 0 in production.
    const legacyRead = await readAllPages<{ id: string; title: string }>(
      (from, to) =>
        client
          .from('collection_items')
          .select('id, title')
          .is('release_id', null)
          .is('artist_slug', null)
          .ilike('artist_name', escapeLikePattern(artistName))
          .order('id')
          .range(from, to),
      'collection_items (awaiting a release, pre-slug rows)'
    );

    const items = legacyRead.ok ? [...itemRead.rows, ...legacyRead.rows] : itemRead.rows;

    const itemsByRelease = new Map<string, string[]>();
    for (const item of items) {
      const releaseId = releaseByKey.get(releaseMatchKey(item.title));
      if (!releaseId) continue;
      const waiting = itemsByRelease.get(releaseId);
      if (waiting) waiting.push(item.id);
      else itemsByRelease.set(releaseId, [item.id]);
    }

    let linked = 0;
    for (const [releaseId, itemIds] of itemsByRelease) {
      for (let i = 0; i < itemIds.length; i += UPDATE_CHUNK) {
        const chunk = itemIds.slice(i, i + UPDATE_CHUNK);
        const { error } = await client
          .from('collection_items')
          .update({ release_id: releaseId })
          .in('id', chunk);

        if (error) {
          console.error('[collection-match] link update failed:', error.message);
          continue;
        }
        linked += chunk.length;
      }
    }

    return linked;
  } catch (error) {
    console.error('[collection-match] link failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
}

/** What one resolve pass did. Every name is accounted for by exactly one of these counts. */
export interface CollectionResolveSummary {
  /** Items with no release attached when the pass started. */
  unlinkedItems: number;
  /** Distinct artists behind those items. */
  artistNames: number;
  /** Already had an `artists` row — no probe needed. */
  alreadyKnown: number;
  /** Stored from a verified Bandcamp probe by this pass. */
  created: number;
  /** The probe found no verifiable Bandcamp page for the name. */
  notFound: number;
  /** Names the non-artist and excluded-artist lists refuse. */
  refused: number;
  /** Past the per-run cap. Reported so a partial pass never reads as a complete one. */
  deferred: number;
  /** Artists whose catalogue this pass asked for directly. */
  catalogRequested: number;
}

const emptySummary = (): CollectionResolveSummary => ({
  unlinkedItems: 0,
  artistNames: 0,
  alreadyKnown: 0,
  created: 0,
  notFound: 0,
  refused: 0,
  deferred: 0,
  catalogRequested: 0,
});

/** The artist at this slug, if any. `match_confidence` comes back so a claimed row is left alone. */
async function artistAtSlug(
  client: SupabaseClient,
  slug: string
): Promise<{ id: string; matchConfidence: string | null } | null> {
  const { data, error } = await client
    .from('artists')
    .select('id, match_confidence')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.error('[collection-match] artist lookup failed:', error.message);
    return null;
  }
  if (!data) return null;
  const row = data as { id: string; match_confidence: string | null };
  return { id: row.id, matchConfidence: row.match_confidence };
}

/** Slugs per artists lookup — keeps the id list well inside URL-length limits. */
const SLUG_LOOKUP_CHUNK = 100;

/**
 * Every artist we already hold from one list of slugs, in one query per chunk. A resolve pass
 * checks up to MAX_ARTISTS_PER_RESOLVE names, and asking one-at-a-time cost ~100 round trips
 * per sync attempt — including failed syncs, which also run this pass. A failed chunk read just
 * leaves its slugs out of the map, so those names fall through to the probe: more work, never a
 * wrong answer.
 */
async function artistsAtSlugs(
  client: SupabaseClient,
  slugs: string[]
): Promise<Map<string, { id: string; matchConfidence: string | null }>> {
  const known = new Map<string, { id: string; matchConfidence: string | null }>();
  for (let i = 0; i < slugs.length; i += SLUG_LOOKUP_CHUNK) {
    const chunk = slugs.slice(i, i + SLUG_LOOKUP_CHUNK);
    const { data, error } = await client
      .from('artists')
      .select('id, slug, match_confidence')
      .in('slug', chunk);

    if (error) {
      console.error('[collection-match] artist batch lookup failed:', error.message);
      continue;
    }
    for (const row of (data ?? []) as { id: string; slug: string; match_confidence: string | null }[]) {
      known.set(row.slug, { id: row.id, matchConfidence: row.match_confidence });
    }
  }
  return known;
}

/**
 * Store an artist discovered from someone's collection, and their Bandcamp link.
 *
 * `match_confidence` is 'unverified', matching what a search stores for an artist whose releases
 * haven't corroborated the match. The probe verified that the account carries this artist's name
 * and holds real releases, which is what makes the row worth creating — it is not the
 * release-level corroboration the search pipeline means by 'verified', so it doesn't claim to be.
 */
async function storeBandcampArtist(
  client: SupabaseClient,
  input: { slug: string; name: string; bandcampUrl: string; imageUrl: string | null }
): Promise<string | null> {
  const { data: artist, error: artistError } = await client
    .from('artists')
    .upsert(
      {
        slug: input.slug,
        name: input.name,
        image_url: input.imageUrl,
        match_confidence: 'unverified',
        source: 'auto',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slug' }
    )
    .select('id')
    .single();

  if (artistError || !artist) {
    console.error(`[collection-match] could not store "${input.name}":`, artistError?.message);
    return null;
  }

  const artistId = (artist as { id: string }).id;

  // `ignoreDuplicates` rather than an overwrite: if this artist somehow already has a Bandcamp
  // row, it came from a search or from the artist themselves, and either is at least as
  // trustworthy as a probe result.
  const { error: linkError } = await client.from('artist_links').upsert(
    {
      artist_id: artistId,
      platform: 'bandcamp',
      url: input.bandcampUrl,
      source: 'collection',
      is_direct: true,
      display_order: 0,
    },
    { onConflict: 'artist_id,platform', ignoreDuplicates: true }
  );

  if (linkError) {
    // Without the link there is nothing to catalogue, so the row alone is not worth reporting
    // as a success.
    console.error(`[collection-match] could not link "${input.name}":`, linkError.message);
    return null;
  }

  return artistId;
}

/**
 * Find the artists behind a fan's unlinked collection items and get their catalogues started.
 *
 * Run after an import, off the request path. The expensive step — one Bandcamp probe per artist
 * name we've never seen — is why: probes are cached in Supabase forever afterwards, negatives
 * included, so this is expensive exactly once per artist across the whole product.
 *
 * Nothing here links anything. Cataloguing is asynchronous by design, so the items stay unlinked
 * until `linkCollectionItemsForArtist` runs at the end of the crawl this pass requests.
 *
 * Never throws. This runs after a sync has already been recorded as complete, and a fan's
 * collection is imported and visible whether or not the artists behind it could be resolved.
 */
export async function resolveCollectionArtists(userId: string): Promise<CollectionResolveSummary> {
  const summary = emptySummary();
  const client = getClient();
  if (!client) return summary;

  const itemRead = await readAllPages<{ artist_name: string }>(
    (from, to) =>
      client
        .from('collection_items')
        .select('artist_name')
        .eq('user_id', userId)
        .is('release_id', null)
        .order('acquired_at', { ascending: false, nullsFirst: false })
        .range(from, to),
    'collection_items (unlinked)'
  );

  if (!itemRead.ok) {
    console.warn('[collection-match] could not read unlinked items:', itemRead.reason);
    return summary;
  }

  summary.unlinkedItems = itemRead.rows.length;

  // Deduped on the slug rather than the raw string, so "Björk" and "Bjork" are one lookup. Newest
  // purchases first, because that's the order the read asked for and the end of a truncated pass
  // should be the records someone bought longest ago.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of itemRead.rows) {
    const slug = artistSlug(row.artist_name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    names.push(row.artist_name);
  }

  summary.artistNames = names.length;
  const toResolve = names.slice(0, MAX_ARTISTS_PER_RESOLVE);
  summary.deferred = names.length - toResolve.length;

  const artistIds: string[] = [];
  const deadline = Date.now() + RESOLVE_DEADLINE_MS;

  // One batched read answers "which of these do we already hold?" for the whole pass — the
  // overwhelmingly common case, since a collection's artists only need probing once ever.
  const knownBySlug = await artistsAtSlugs(
    client,
    toResolve.map(name => artistSlug(name)).filter(Boolean)
  );

  for (const [index, name] of toResolve.entries()) {
    if (Date.now() > deadline) {
      summary.deferred += toResolve.length - index;
      console.warn(`[collection-match] out of time with ${toResolve.length - index} name(s) left`);
      break;
    }

    const slug = artistSlug(name);

    // The same two editorial gates a search passes through. A collection is a stronger signal
    // than a search — someone paid for this — but neither list is about signal strength: one
    // keeps software and TV shows from minting artist pages, the other is a deliberate
    // exclusion, and a purchase doesn't overturn either.
    if (isNonArtistSlug(slug) || isExcludedArtistSlug(slug)) {
      summary.refused++;
      continue;
    }

    const existing = knownBySlug.get(slug) ?? null;
    if (existing) {
      summary.alreadyKnown++;
      // A claimed profile is left entirely alone — its links are the artist's own curation — but
      // it is still worth cataloguing, which is gated by whether it has a catalogue-able link.
      artistIds.push(existing.id);
      continue;
    }

    const match = await findBandcampArtist(name);
    await sleep(DELAY_BETWEEN_PROBES_MS);

    if (!match) {
      // Either genuinely not on Bandcamp under any candidate slug, or the probe couldn't tell.
      // It caches those two differently, so a transient failure here retries next time rather
      // than becoming a permanent verdict — see findBandcampArtist.
      summary.notFound++;
      continue;
    }

    // Whoever already owns this Bandcamp URL owns these releases too, whatever name the
    // collection spells them under.
    const ownerSlug = await findArtistSlugByBandcampUrl(match.url);
    if (ownerSlug && ownerSlug !== slug) {
      const owner = await artistAtSlug(client, ownerSlug);
      if (owner) {
        summary.alreadyKnown++;
        artistIds.push(owner.id);
        continue;
      }
    }

    const artistId = await storeBandcampArtist(client, {
      slug,
      name,
      bandcampUrl: match.url,
      imageUrl: match.imageUrl,
    });

    if (!artistId) continue;
    summary.created++;
    artistIds.push(artistId);
  }

  // 'saved' rather than 'searched': the trigger picks the hourly budget, and the larger one is
  // for work a person deliberately asked for. Connecting a collection is that — and buying a
  // record is a stronger statement of interest than saving an artist, which already qualifies.
  const requested = [...new Set(artistIds)].slice(0, MAX_CATALOG_REQUESTS);
  if (requested.length > 0 && (await requestArtistCatalog(requested, 'saved'))) {
    summary.catalogRequested = requested.length;
  }

  return summary;
}
