// What a catalogue pass writes: releases and their sources, deduplicated against what is stored.
// One persister per platform (Bandcamp, Discogs, Faircamp, Jam.coop, Mirlo), the release-detail
// pass, and MusicBrainz dates and ids. They share the private source helpers at the top of the
// file. Not to be confused with ../release-ingest.ts, which maps a fetched Bandcamp page into the
// rows written here.

import type { SupabaseClient } from '@supabase/supabase-js';
import { findExactReleaseMatch, findFuzzyReleaseMatch } from '../release-utils';
import { Sentry } from '../../lib/sentry';
import { getClient } from './client';

interface ReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  artworkUrl: string | null;
  source: { platform: string; url: string; externalId: string | null };
}

/**
 * A release row and its source after a write, which is what the detail pass needs to decide
 * whether to spend a request on this release's own page.
 */
export interface PersistedRelease {
  releaseId: string;
  sourceId: string;
  /** The release page for this source — where the date, formats and prices live. */
  url: string;
  /** When that page was last read. Null means never. */
  detailCheckedAt: string | null;
  /** Columns on the release row a verified artist has authored. Ingest leaves these alone. */
  curatedFields: string[];
}

/**
 * Write a catalog run's releases, merging rather than replacing.
 *
 * Three rules that matter more than they look:
 *
 * 1. **Match on `(artist_id, match_key)`, not on slug.** A slug is derived from a title and
 *    changes when the title does; the match key is what identity means here. Release type is
 *    not part of that identity — see `findExactReleaseMatch` for why it can't be, and for the
 *    date check that stands in its place.
 * 2. **Never overwrite a stored value with null.** A partial run — Bandcamp slow, artwork
 *    missing — must not erase a date or artwork a previous run found. This is "never cache
 *    uncertainty" in write form.
 * 3. **Never touch a field an artist has edited.** `curated_fields` lists columns a verified
 *    artist authored; ingest re-runs forever, so without this every crawl silently reverts
 *    their corrections.
 *
 * Returns the releases written or updated, in the order they were given — which for a
 * Bandcamp grid is newest first, so a budgeted detail pass reading the front of the list
 * spends its requests on the releases a fan is most likely to be looking at.
 */
/**
 * Which `(release_id, platform)` source rows an artist has claimed — added or corrected
 * themselves via the curation UI, rather than ingest. Every ingest path must read this before
 * writing a source row: a re-crawl silently overwriting an artist's fix in 30 days would be the
 * exact "ingest clobbers a curated edit" bug `curated_fields` exists to prevent on `releases`
 * itself, just one table over.
 */
export interface ExistingReleaseSource {
  id: string;
  release_id: string;
  platform: string;
  url: string;
  external_id: string | null;
  source: string | null;
  detail_checked_at: string | null;
}

/**
 * Keyed `${releaseId}:${platform}:${externalId ?? ''}` — the table's own uniqueness rule since
 * `20260829120000_release-sources-multi-per-platform.sql`. The empty-string tail is what a row
 * with no external id keys under, and there can be at most one of those per platform.
 */
export type ExistingSourceMap = Map<string, ExistingReleaseSource>;

/** The one place that key is spelled, so a reader and a writer can't drift apart. */
export function releaseSourceKey(releaseId: string, platform: string, externalId: string | null): string {
  return `${releaseId}:${platform}:${externalId ?? ''}`;
}

/**
 * Every `release_sources` row these releases already have.
 *
 * This used to read only the *claimed* keys, as a Set, so `upsertReleaseSource` knew what not to
 * overwrite. It now reads the whole row for every source, which lets that function answer two more
 * questions without a round trip: what a claimed row already says (previously a per-release read),
 * and whether an unclaimed row would actually change (previously an unconditional write).
 *
 * Same one query either way — just more columns.
 */
async function getExistingSources(client: SupabaseClient, releaseIds: string[]): Promise<ExistingSourceMap> {
  const map: ExistingSourceMap = new Map();
  if (releaseIds.length === 0) return map;

  const { data, error } = await client
    .from('release_sources')
    .select('id, release_id, platform, url, external_id, source, detail_checked_at')
    .in('release_id', releaseIds);

  if (error) {
    // An empty map means "assume nothing exists", so every source is written as before. Failing
    // towards writing is right: the alternative is skipping a real update because a read blipped.
    console.error('[DB] getExistingSources failed:', error.message);
    return map;
  }

  for (const row of (data as ExistingReleaseSource[]) || []) {
    map.set(releaseSourceKey(row.release_id, row.platform, row.external_id), row);
  }
  return map;
}

/**
 * Which of these listings already belong to a release of some *other* artist row.
 *
 * `UNIQUE (platform, external_id)` is global, so such a listing can never become a source here:
 * a new release made for it would lose its source write and be deleted again by
 * `discardUnsourcedRelease` — an insert and a delete on every catalogue pass, for good. Measured
 * 2026-11-07, that was every `[catalog] new releases discarded` event: a Faircamp site shared by
 * several artists (the label's releases held by whichever artist was catalogued first), a release
 * credited to two artists, two rows for one artist sharing a link. Checking first, in one read per
 * pass, means the pass writes nothing for them.
 *
 * `ownReleaseIds` are this artist's releases; a hit on one of those is `findReleaseBySource`'s
 * business, not this function's. A failed read returns an empty set, which falls back to the old
 * behaviour (insert, fail, discard, report) rather than skipping a real release because a read
 * blipped.
 */
async function getListingsHeldElsewhere(
  client: SupabaseClient,
  platform: string,
  externalIds: (string | null)[],
  ownReleaseIds: string[]
): Promise<Set<string>> {
  const held = new Set<string>();
  const ids = [...new Set(externalIds.filter((id): id is string => Boolean(id)))];
  const own = new Set(ownReleaseIds);

  // Chunked because these ids are full URLs for Faircamp, Jam.coop and Mirlo, and they travel in
  // the request URL.
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await client
      .from('release_sources')
      .select('release_id, external_id')
      .eq('platform', platform)
      .in('external_id', ids.slice(i, i + 100));

    if (error) {
      console.error('[DB] getListingsHeldElsewhere failed:', error.message);
      return new Set();
    }
    for (const row of (data as { release_id: string; external_id: string }[]) || []) {
      if (!own.has(row.release_id)) held.add(row.external_id);
    }
  }
  return held;
}

/** One log line per pass for the listings skipped because another artist holds them. */
function logHeldElsewhere(artistId: string, platform: string, count: number): void {
  if (count === 0) return;
  console.log(`[DB] ${platform} catalogue for ${artistId}: skipped ${count} listing(s) another artist already holds`);
}

/**
 * The stored release that already holds this platform listing, if any — checked before any
 * title match, because the platform's own id is a stronger identity than our reading of its
 * title. `UNIQUE (platform, external_id)` already lets a listing belong to only one release, so
 * this can't merge anything the table doesn't already assert.
 *
 * Without it, a listing whose title stopped matching its release's `match_key` — Faircamp and
 * Mirlo append "(single)", "(EP)", "[Compilation]" — was treated as a new release: a row was
 * inserted (and, on the fuzzy paths, flagged for review), then its source write hit the unique
 * constraint and failed, leaving a release with no sources at all. Merging that phantom away in
 * `/admin/release-review` only deleted it until the next scheduled re-catalogue made it again,
 * which is how the queue held the same pairs week after week (found 2026-10-01: all nine pairs
 * in the queue were this).
 *
 * Linear over the artist's sources, read live from `existingSources` so a source written earlier
 * in the same pass counts too.
 */
export function findReleaseBySource<T extends { id: string }>(
  existing: T[],
  existingSources: ExistingSourceMap,
  platform: string,
  externalId: string | null
): T | undefined {
  if (!externalId) return undefined;
  for (const source of existingSources.values()) {
    if (source.platform === platform && source.external_id === externalId) {
      return existing.find(row => row.id === source.release_id);
    }
  }
  return undefined;
}

/**
 * Write one release's source row — or don't, when writing it would change nothing.
 *
 * The one place every ingest path goes through to write `release_sources`, so the two rules below
 * only have to be correct once:
 *
 * 1. **Never overwrite a claimed source.** `source: 'claimed'` means an artist added or corrected
 *    this URL themselves; a re-crawl silently replacing it in 30 days is the same bug
 *    `curated_fields` prevents on `releases`, one table over. The claimed row is returned as-is.
 * 2. **Never rewrite an unchanged row.** This used to upsert unconditionally on every pass, which
 *    meant every re-catalogue rewrote every source row it already held — new tuple version, index
 *    entries, WAL, dead tuple — to restate a URL that hadn't moved. Platform URLs almost never
 *    move, so almost all of that was waste, and it contributed to the Disk IO Budget alert.
 *
 * **`last_seen_at` is the casualty of rule 2 and is worth knowing about.** It used to be stamped on
 * every pass, so it meant "when we last confirmed this source exists"; it now only advances when
 * something else about the row changes, so it effectively means "when this row was last written".
 * Nothing reads the column — it has no consumer anywhere in the codebase — which is what makes the
 * trade acceptable. If a real "last confirmed" signal is ever needed, it wants its own cheap
 * mechanism (a periodic batched touch), not a rewrite of every row on every crawl.
 *
 * `detail_checked_at` is read back rather than written, in every branch: it belongs to the detail
 * pass, and a grid re-crawl must not reset it or every crawl would re-fetch every release page.
 */
async function upsertReleaseSource(
  client: SupabaseClient,
  releaseId: string,
  platform: string,
  url: string,
  externalId: string | null,
  existingSources: ExistingSourceMap
): Promise<{ id: string; url: string; detail_checked_at: string | null } | null> {
  // Exact match on the platform's own id first. Failing that, a row for this platform that has
  // no id yet is the same source before we learned what to call it — an early Bandcamp crawl
  // that stored a URL and nothing else, say — so it gets upgraded in place rather than joined
  // by a second row. Only a genuinely new id inserts.
  const priorByExternalId = existingSources.get(releaseSourceKey(releaseId, platform, externalId));
  const priorByNullExternalId = externalId ? existingSources.get(releaseSourceKey(releaseId, platform, null)) : undefined;
  const prior = priorByExternalId ?? priorByNullExternalId;
  // The key `prior` actually lives under — `prior?.external_id` is wrong when the null-id
  // fallback matched and `externalId` is non-null, since it collapses to the *new* key via `??`
  // and leaves the stale null-keyed entry in the map for a later source in this pass to hit.
  const priorKey = priorByExternalId
    ? releaseSourceKey(releaseId, platform, externalId)
    : priorByNullExternalId
      ? releaseSourceKey(releaseId, platform, null)
      : undefined;

  if (prior?.source === 'claimed') {
    return { id: prior.id, url: prior.url, detail_checked_at: prior.detail_checked_at };
  }

  if (prior && prior.url === url && prior.external_id === externalId) {
    return { id: prior.id, url: prior.url, detail_checked_at: prior.detail_checked_at };
  }

  // Written as an explicit update-or-insert rather than an upsert: PostgREST infers the conflict
  // target from a plain column list, and this table's uniqueness now lives in an expression
  // index (COALESCE(external_id, '')) that no column list can name.
  const row = {
    release_id: releaseId,
    platform,
    url,
    external_id: externalId,
    last_seen_at: new Date().toISOString(),
  };

  const { data, error } = prior
    ? await client.from('release_sources').update(row).eq('id', prior.id).select('id, url, external_id, source, detail_checked_at').single()
    : await client.from('release_sources').insert(row).select('id, url, external_id, source, detail_checked_at').single();

  if (error || !data) {
    // 23505 here almost always means another release — usually another *artist's* — already
    // holds this listing, since `UNIQUE (platform, external_id)` is global.
    console.error('[DB] upsertReleaseSource failed:', error?.code, error?.message);
    return null;
  }

  // Keep the map honest for the rest of this pass, so a second release resolving to the same
  // source doesn't insert over the top of a row this call just wrote.
  const written = data as ExistingReleaseSource;
  if (priorKey) existingSources.delete(priorKey);
  existingSources.set(releaseSourceKey(releaseId, platform, externalId), {
    ...written,
    release_id: releaseId,
    platform,
  });

  return { id: written.id, url: written.url, detail_checked_at: written.detail_checked_at };
}

/**
 * Delete a release row this pass inserted moments ago, because its source write then failed.
 *
 * A release with no source is a page with nowhere to buy the record — the outcome
 * `persistMusicBrainzEnrichment` refuses to create on purpose — and the ingest paths insert the
 * row *before* the fallible source write, so a failure used to leave exactly that behind. Measured
 * 2026-10-01: 676 of 31,496 releases had no sources, ~600 of them because the listing already
 * belonged to a different artist's release (a Faircamp label site linked from several artist rows,
 * or two rows for one artist sharing a Bandcamp link), which `UNIQUE (platform, external_id)`
 * rejects. They rendered on artist pages, release pages and feeds.
 *
 * Only ever called on a row inserted in the same pass, before anything could reference it: the
 * fuzzy partner is flagged only after the source write succeeds, so there is no review flag to
 * undo. Returns false when the delete itself fails, which leaves the row behind and is logged.
 */
async function discardUnsourcedRelease(client: SupabaseClient, releaseId: string, caller: string): Promise<boolean> {
  const { error } = await client.from('releases').delete().eq('id', releaseId);
  if (error) {
    console.error(`[DB] ${caller} could not discard source-less release`, releaseId, error.message);
    return false;
  }
  return true;
}

/**
 * One Sentry event per pass, not per release. Listings another artist already holds are skipped
 * before this point (getListingsHeldElsewhere), so what reaches it is unexpected: a race with
 * another pass, or a source write that failed for some other reason.
 */
function reportDiscardedReleases(artistId: string, platform: string, count: number): void {
  if (count === 0) return;
  Sentry.captureMessage('[catalog] new releases discarded: source write failed', {
    level: 'warning',
    tags: { area: 'release-catalog', kind: 'unsourced-release-discarded', platform },
    extra: { artistId, count },
  });
}

export async function persistReleases(
  artistId: string,
  releases: ReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      // `title` is read so the patch below can compare instead of assigning unconditionally.
      .select('id, slug, title, match_key, release_type, release_date, date_precision, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      title: string | null;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];
    let discarded = 0;
    const catalogPlatform = releases[0].source.platform;
    let skippedHeldElsewhere = 0;
    const heldElsewhere = await getListingsHeldElsewhere(client, catalogPlatform, releases.map(r => r.source.externalId), existing.map(r => r.id));

    for (const release of releases) {
      // The listing's own id first (see findReleaseBySource), then title identity — not
      // `(release_type, match_key)` identity, see findExactReleaseMatch.
      const prior =
        findReleaseBySource(existing, existingSources, release.source.platform, release.source.externalId) ??
        findExactReleaseMatch(existing, release);
      const curated = new Set(prior?.curated_fields ?? []);

      let releaseId: string;
      let createdRow: ExistingRow | null = null;

      if (prior) {
        const patch: Record<string, unknown> = {};
        // COALESCE semantics, applied in JS: only fill what's missing, never blank what's set,
        // and never touch what the artist edited.
        //
        // `!== prior.title` matters more than it looks: this used to assign the title
        // unconditionally, which meant every re-catalogue rewrote every release row it already
        // held — six indexes each — even when the title was byte-identical, which it almost always
        // is. With the comparison, an unchanged release now falls through to an empty patch and
        // does no write at all. See PERSIST_REFRESH_FLOOR_MS for the same problem on `artists`.
        //
        // Only when the match keys agree: a release found by its source id may carry a title
        // that normalizes differently, and writing it would leave `title` and `match_key`
        // describing two different strings. The stored title stays until a human changes it.
        if (!curated.has('title') && release.title !== prior.title && release.matchKey === prior.match_key) {
          patch.title = release.title;
        }
        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        // Another artist's release holds this listing, so it can never be a source here.
        if (release.source.platform === catalogPlatform && release.source.externalId && heldElsewhere.has(release.source.externalId)) {
          skippedHeldElsewhere++;
          continue;
        }

        // Slug must not collide with anything already stored for this artist.
        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        // Visible to the rest of this batch, so two titles that normalize alike don't both insert.
        createdRow = {
          id: releaseId,
          slug,
          title: release.title,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        existing.push(createdRow);
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        release.source.platform,
        release.source.url,
        release.source.externalId,
        existingSources
      );

      if (!source) {
        console.error('[DB] persistReleases source write failed for release', releaseId);
        if (createdRow && (await discardUnsourcedRelease(client, releaseId, 'persistReleases'))) {
          existing.splice(existing.indexOf(createdRow), 1);
          discarded++;
        }
        continue;
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields: [...curated],
      });
    }

    logHeldElsewhere(artistId, catalogPlatform, skippedHeldElsewhere);
    reportDiscardedReleases(artistId, releases[0].source.platform, discarded);
    return written;
  } catch (error) {
    console.error('[DB] persistReleases error:', error);
    return [];
  }
}

interface DetailToPersist {
  releaseDate: string | null;
  datePrecision: string;
  /**
   * Null when this source has nothing to say about the release row itself — Faircamp publishes
   * prices but no date anywhere in its markup, so it can't derive a status either. Writing its
   * default 'released' would overwrite an 'announced' that Bandcamp got right from a real
   * pre-order, so the row is left alone entirely and only the offers are written.
   */
  status: string | null;
  offers: Array<{
    format: string;
    price: number | null;
    currency: string | null;
    availability: string;
  }>;
}

interface ReleaseDetailColumns {
  status: string | null;
  release_date: string | null;
  date_precision: string | null;
}

interface StoredOffer {
  format: string;
  price: number | string | null;
  currency: string | null;
  availability: string;
}

/** Would writing this detail's status/date change the release row at all? */
function releaseRowMatchesDetail(prior: ReleaseDetailColumns | null, detail: DetailToPersist): boolean {
  if (!prior) return false;
  if (prior.status !== detail.status) return false;
  if (!detail.releaseDate) return true;
  // A `date` column reads back as YYYY-MM-DD whatever ISO shape was written into it, so
  // compare on that prefix — a raw string compare against a full timestamp would never match
  // and would quietly turn this skip into a no-op.
  const priorDate = prior.release_date ? String(prior.release_date).slice(0, 10) : null;
  return priorDate === detail.releaseDate.slice(0, 10) && prior.date_precision === detail.datePrecision;
}

/** Same offers, field for field? Order-independent; formats are unique per source. */
function offersMatch(prior: StoredOffer[], offers: DetailToPersist['offers']): boolean {
  if (prior.length !== offers.length) return false;
  const byFormat = new Map(prior.map(o => [o.format, o]));
  return offers.every(offer => {
    const stored = byFormat.get(offer.format);
    if (!stored) return false;
    // `price` is numeric in Postgres; normalize so a string-serialized number still matches.
    const storedPrice = stored.price == null ? null : Number(stored.price);
    return (
      storedPrice === (offer.price ?? null) &&
      (stored.currency ?? null) === (offer.currency ?? null) &&
      stored.availability === offer.availability
    );
  });
}

/**
 * Write what a release's own page told us: its date, and what you can buy there.
 *
 * The order of operations is the interesting part. Offers are written **before** stale ones
 * are pruned, and `detail_checked_at` is stamped **last**:
 *
 * - Writing before pruning means a failure part-way through leaves the old offers in place
 *   rather than an empty offer list. This project has already destroyed an artist's links
 *   once with a delete-before-a-fallible-write (PR #350); an empty release page is the same
 *   shape of mistake.
 * - Pruning only happens when the page actually offered something. Zero offers is the normal
 *   state of a standalone track page, so treating it as "everything was withdrawn" would
 *   erase real prices.
 * - Stamping last means an interrupted run is retried next cycle instead of being recorded as
 *   done.
 *
 * Both writes are read-compare-skip, for the same reason as persistReleases' title comparison:
 * in steady state a 30-day re-check re-derives exactly what the rows already say, and writing
 * it anyway costs a new tuple plus every index to restate nothing — at ~hundreds of detail
 * refreshes a day, that was the largest remaining write source after the first Disk IO audit.
 * A failed pre-read falls through to writing (same rule as getExistingSources): skipping a real
 * update because a read blipped is the worse trade.
 *
 * The casualty is `release_offers.captured_at`, which now advances only when an offer actually
 * changes — it means "when this price last moved", not "when we last confirmed it". The
 * "prices checked" freshness shown to users comes from `release_sources.detail_checked_at`,
 * which IS stamped on every pass (release-detail.ts and release-page.ts both read it).
 *
 * Returns false when nothing could be written, so the caller can count it as a failure.
 */
export async function persistReleaseDetail(
  release: PersistedRelease,
  detail: DetailToPersist
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    // A date the artist authored outranks anything upstream says, and status is derived from
    // the date, so a curated date takes both columns out of ingest's hands.
    if (detail.status !== null && !release.curatedFields.includes('release_date')) {
      const patch: Record<string, unknown> = { status: detail.status };
      if (detail.releaseDate) {
        patch.release_date = detail.releaseDate;
        patch.date_precision = detail.datePrecision;
      }

      const { data: prior } = await client
        .from('releases')
        .select('status, release_date, date_precision')
        .eq('id', release.releaseId)
        .maybeSingle();

      if (!releaseRowMatchesDetail(prior as ReleaseDetailColumns | null, detail)) {
        const { error } = await client.from('releases').update(patch).eq('id', release.releaseId);
        if (error) {
          console.error('[DB] persistReleaseDetail release update failed:', error.message);
          return false;
        }
      }
    }

    if (detail.offers.length > 0) {
      const { data: priorOffers, error: priorOffersError } = await client
        .from('release_offers')
        .select('format, price, currency, availability')
        .eq('release_source_id', release.sourceId);

      const unchanged =
        !priorOffersError && offersMatch((priorOffers as StoredOffer[]) ?? [], detail.offers);

      if (!unchanged) {
        const capturedAt = new Date().toISOString();
        const { error: offerError } = await client.from('release_offers').upsert(
          detail.offers.map(offer => ({
            release_source_id: release.sourceId,
            format: offer.format,
            price: offer.price,
            currency: offer.currency,
            availability: offer.availability,
            captured_at: capturedAt,
          })),
          { onConflict: 'release_source_id,format' }
        );

        if (offerError) {
          console.error('[DB] persistReleaseDetail offer upsert failed:', offerError.message);
          return false;
        }

        const { error: pruneError } = await client
          .from('release_offers')
          .delete()
          .eq('release_source_id', release.sourceId)
          .not('format', 'in', `(${detail.offers.map(o => o.format).join(',')})`);

        // A failed prune leaves a stale format listed, which is worth logging but not worth
        // failing the whole detail write over — the prices we did just refresh are still good.
        if (pruneError) {
          console.error('[DB] persistReleaseDetail offer prune failed:', pruneError.message);
        }
      }
    }

    const { error: stampError } = await client
      .from('release_sources')
      .update({ detail_checked_at: new Date().toISOString() })
      .eq('id', release.sourceId);

    if (stampError) {
      console.error('[DB] persistReleaseDetail stamp failed:', stampError.message);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[DB] persistReleaseDetail error:', error);
    return false;
  }
}

interface DiscogsReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  masterId: string;
  mainReleaseId: string;
}

/**
 * Write a Discogs catalog pass, merging into whatever's already there rather than replacing
 * it — same shape and same three rules as `persistReleases`, plus a fourth this source needs
 * and Bandcamp didn't, because Bandcamp is the only source in the catalog:
 *
 * 4. **Prefer the hard identifier over the title guess.** `discogs_master_id` is Discogs'
 *    own "these pressings are one album" conclusion — tier 1 in the dedup scheme (spec §4).
 *    Only fall back to the title match — tier 2, `findExactReleaseMatch` — when this artist
 *    has no row with that master id yet, and only when that tier-2 candidate doesn't already
 *    carry a *different* master id (which would mean the title match is coincidental, not the
 *    same release). And when nothing matches exactly but a title is merely *close* to an
 *    existing one, this never merges either: it inserts a new row and flags both
 *    `needs_review`, which is tier 3. A human decides; the catalog never silently asserts two
 *    different albums are the same one.
 *
 *    A master id is looked up in `release_sources` as well as in `releases.discogs_master_id`,
 *    because the release column holds only one and an admin merge of two masters leaves the
 *    second on the source row. Skipping that read is what would let a merged pair come back.
 */
export async function persistDiscogsReleases(
  artistId: string,
  releases: DiscogsReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      // `title` is read so the patch below can compare instead of assigning unconditionally.
      .select('id, slug, title, match_key, release_type, release_date, date_precision, curated_fields, discogs_master_id')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistDiscogsReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      title: string | null;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      curated_fields: string[] | null;
      discogs_master_id: string | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byMasterId = new Map(
      existing.filter(r => r.discogs_master_id).map(r => [r.discogs_master_id as string, r])
    );
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    // A release that an admin merged with a second Discogs master carries that master's id on
    // its *source* row: `releases.discogs_master_id` holds exactly one, and the merge keeps the
    // survivor's. Reading both is what makes such a merge durable — without it, the very next
    // catalogue pass wouldn't recognise the second master and would re-create the row the human
    // just merged away, which is how a review queue refills itself forever.
    //
    // Kept in its own map rather than folded into `byMasterId`, because these two answer
    // different questions. `byMasterId` means "this row *is* that master", which is what
    // licenses overwriting the stored title from Discogs. A merged-away master means "this row
    // absorbed that master" — the title on the survivor is the one a human chose to keep, and
    // the other master's title must not replace it.
    const byReleaseId = new Map(existing.map(r => [r.id, r]));
    const byMergedMasterId = new Map<string, ExistingRow>();
    for (const source of existingSources.values()) {
      if (source.platform !== 'discogs' || !source.external_id) continue;
      if (byMasterId.has(source.external_id)) continue;
      const row = byReleaseId.get(source.release_id);
      if (row) byMergedMasterId.set(source.external_id, row);
    }

    const written: PersistedRelease[] = [];
    let discarded = 0;
    let skippedHeldElsewhere = 0;
    const heldElsewhere = await getListingsHeldElsewhere(client, 'discogs', releases.map(r => r.masterId), existing.map(r => r.id));

    for (const release of releases) {
      let prior = byMasterId.get(release.masterId);
      const matchedByMasterId = Boolean(prior);
      if (!prior) prior = byMergedMasterId.get(release.masterId);

      if (!prior) {
        const exact = findExactReleaseMatch(existing, release);
        // A tier-2 title match that already carries a *different* master id is Discogs itself
        // saying these are two records, which outranks our title guess.
        if (exact && (!exact.discogs_master_id || exact.discogs_master_id === release.masterId)) {
          prior = exact;
        }
      }

      // Tier 3: nothing exact, but something close enough to warrant a human look. Never
      // merge — insert a new row below and flag both sides, with each pointing at the other
      // via `flagged_against_release_id` so an admin queue can show the pair without having
      // to re-run the fuzzy match to reconstruct what triggered it.
      //
      // Searched across every stored release, not just those of this one's type, same as tier 2
      // above and every other source: Discogs types 92% of its masters 'other', so scoping by
      // type meant a near-match against a Bandcamp 'album' was never put in front of a human.
      const fuzzy = prior ? null : findFuzzyReleaseMatch(existing, release);

      let releaseId: string;
      let curatedFields: string[];
      let createdRow: ExistingRow | null = null;

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        // Title is only ever taken from a hard-identifier match (a re-crawl of a release we
        // already know is this one). A tier-2 title-equality match means the two titles
        // already normalize the same — overwriting risks nothing informative and risks
        // clobbering a display-quality title Bandcamp already got right.
        // Compared rather than assigned, for the same reason as persistReleases above: a re-crawl
        // that finds the identical title should write nothing.
        if (!curated.has('title') && matchedByMasterId && release.title !== prior.title) {
          patch.title = release.title;
        }
        if (!prior.discogs_master_id) patch.discogs_master_id = release.masterId;
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistDiscogsReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        // Another artist's release holds this listing, so it can never be a source here.
        if (release.masterId && heldElsewhere.has(release.masterId)) {
          skippedHeldElsewhere++;
          continue;
        }

        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            discogs_master_id: release.masterId,
            source: 'auto',
            // fuzzy.id is already known here, unlike the reverse direction below — this row
            // can point at its suspected duplicate in the same write that creates it.
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistDiscogsReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        createdRow = {
          id: releaseId,
          slug,
          title: release.title,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          curated_fields: [],
          discogs_master_id: release.masterId,
        };
        byMasterId.set(release.masterId, createdRow);
        existing.push(createdRow);
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        'discogs',
        // The specific pressing Discogs treats as this master's representative release — a
        // real listing page, unlike the abstract master page.
        `https://www.discogs.com/release/${release.mainReleaseId}`,
        release.masterId,
        existingSources
      );

      if (!source) {
        console.error('[DB] persistDiscogsReleases source write failed for release', releaseId);
        // Typically a master credited to two artists (a collaboration or split) that the other
        // artist's release already holds — the source table allows it on only one release.
        if (createdRow && (await discardUnsourcedRelease(client, releaseId, 'persistDiscogsReleases'))) {
          const row = createdRow;
          byMasterId.delete(release.masterId);
          existing.splice(existing.indexOf(row), 1);
          discarded++;
        }
        continue;
      }

      // The reverse direction: fuzzy's own id wasn't known until the new row existed, so this
      // side is written second — and only once the new row has its source, so a row discarded
      // above can't leave its partner flagged against nothing. Never merge — flagging both
      // sides is the whole point of tier 3.
      if (createdRow && fuzzy) {
        const { error: flagError } = await client
          .from('releases')
          .update({ needs_review: true, flagged_against_release_id: releaseId })
          .eq('id', fuzzy.id);
        if (flagError) console.error('[DB] persistDiscogsReleases fuzzy-flag failed:', flagError.message);
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    logHeldElsewhere(artistId, 'discogs', skippedHeldElsewhere);
    reportDiscardedReleases(artistId, 'discogs', discarded);
    return written;
  } catch (error) {
    console.error('[DB] persistDiscogsReleases error:', error);
    return [];
  }
}

interface MusicBrainzEnrichmentInput {
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  mbid: string;
}

/**
 * Fill in what MusicBrainz knows about releases we already have: a date at whatever precision
 * MusicBrainz actually carries, and the release-group MBID as a hard identity anchor for
 * future dedup passes (including Discogs and Bandcamp re-crawls, once one of them also finds
 * this MBID some other way).
 *
 * **Update-only, by design.** MusicBrainz has no purchase link to offer, so unlike Bandcamp
 * and Discogs this never inserts a new release row — a release page with a date and nowhere
 * to buy it would be a worse outcome than not having the page at all.
 *
 * Matches tier 1 (an existing `musicbrainz_release_group_id`) first, then tier 2
 * (`findExactReleaseMatch`) — and only when that tier-2 candidate doesn't already carry a
 * *different* MBID, which would mean the title match is coincidental. Returns how many rows
 * were touched.
 */
export async function persistMusicBrainzEnrichment(
  artistId: string,
  groups: MusicBrainzEnrichmentInput[]
): Promise<number> {
  const client = getClient();
  if (!client || groups.length === 0) return 0;

  try {
    const { data: existingRows, error } = await client
      .from('releases')
      .select('id, match_key, release_type, release_date, date_precision, curated_fields, musicbrainz_release_group_id')
      .eq('artist_id', artistId);

    if (error) {
      console.error('[DB] persistMusicBrainzEnrichment read failed:', error.message);
      return 0;
    }

    type ExistingRow = {
      id: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      curated_fields: string[] | null;
      musicbrainz_release_group_id: string | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const byMbid = new Map(
      existing.filter(r => r.musicbrainz_release_group_id).map(r => [r.musicbrainz_release_group_id as string, r])
    );

    let touched = 0;

    for (const group of groups) {
      let row = byMbid.get(group.mbid);
      if (!row) {
        const candidate = findExactReleaseMatch(existing, group);
        if (candidate && (!candidate.musicbrainz_release_group_id || candidate.musicbrainz_release_group_id === group.mbid)) {
          row = candidate;
        }
      }
      // MusicBrainz alone never creates a row — if nothing here matches, there's nothing yet
      // to attach this enrichment to.
      if (!row) continue;

      const curated = new Set(row.curated_fields ?? []);
      const patch: Record<string, unknown> = {};
      if (!row.musicbrainz_release_group_id) patch.musicbrainz_release_group_id = group.mbid;
      if (!curated.has('release_date') && group.releaseDate && !row.release_date) {
        patch.release_date = group.releaseDate;
        patch.date_precision = group.datePrecision;
      }
      if (Object.keys(patch).length === 0) continue;

      const { error: updateError } = await client.from('releases').update(patch).eq('id', row.id);
      if (updateError) {
        console.error('[DB] persistMusicBrainzEnrichment update failed:', updateError.message);
        continue;
      }
      touched++;
    }

    return touched;
  } catch (error) {
    console.error('[DB] persistMusicBrainzEnrichment error:', error);
    return 0;
  }
}

/**
 * Write a Faircamp catalog pass.
 *
 * Matches on `match_key` via `findExactReleaseMatch`, which ignores release type. Faircamp's
 * own type guess (`mapDiscogsFormatToReleaseType` reading just a title) is unreliable enough
 * that partitioning by it would systematically block the one thing that makes Faircamp worth
 * ingesting: merging into a release Bandcamp or Discogs already typed correctly, adding
 * Faircamp as a second source on the *same* row instead of a duplicate. That argument turned
 * out to hold for every source, which is why it is now the rule everywhere rather than this
 * function's exception. When nothing matches exactly, a title merely *close* to an existing
 * one still only ever flags (tier 3) — never merges — same as Discogs.
 *
 * Faircamp publishes no release date, so the date check inside both matchers is inert here:
 * with nothing to compare, there is no evidence of difference and the title stands alone.
 *
 * Release type is never overwritten on an existing row; whichever source typed it first stands.
 */
interface FaircampReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  status: string;
  artworkUrl: string | null;
  externalUrl: string;
}

export async function persistFaircampReleases(
  artistId: string,
  releases: FaircampReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      .select('id, slug, match_key, release_type, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistFaircampReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];
    let discarded = 0;
    let skippedHeldElsewhere = 0;
    const heldElsewhere = await getListingsHeldElsewhere(client, 'faircamp', releases.map(r => r.externalUrl), existing.map(r => r.id));

    for (const release of releases) {
      // The listing's own id first — see findReleaseBySource for the phantom rows this prevents.
      const prior =
        findReleaseBySource(existing, existingSources, 'faircamp', release.externalUrl) ??
        findExactReleaseMatch(existing, release);

      let releaseId: string;
      let curatedFields: string[];
      let createdRow: ExistingRow | null = null;
      let fuzzyPartnerId: string | null = null;

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistFaircampReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        // Another artist's release holds this listing, so it can never be a source here.
        if (release.externalUrl && heldElsewhere.has(release.externalUrl)) {
          skippedHeldElsewhere++;
          continue;
        }

        const fuzzy = findFuzzyReleaseMatch(existing, release);

        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistFaircampReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        createdRow = {
          id: releaseId,
          slug,
          match_key: release.matchKey,
          release_type: release.releaseType,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        existing.push(createdRow);
        fuzzyPartnerId = fuzzy?.id ?? null;
      }

      const source = await upsertReleaseSource(client, releaseId, 'faircamp', release.externalUrl, release.externalUrl, existingSources);
      if (!source) {
        console.error('[DB] persistFaircampReleases source write failed for release', releaseId);
        if (createdRow && (await discardUnsourcedRelease(client, releaseId, 'persistFaircampReleases'))) {
          existing.splice(existing.indexOf(createdRow), 1);
          discarded++;
        }
        continue;
      }

      // Flagged only once the new row has its source, so a discarded row can't leave its
      // partner flagged against nothing.
      if (fuzzyPartnerId) {
        const { error: flagError } = await client
          .from('releases')
          .update({ needs_review: true, flagged_against_release_id: releaseId })
          .eq('id', fuzzyPartnerId);
        if (flagError) console.error('[DB] persistFaircampReleases fuzzy-flag failed:', flagError.message);
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    logHeldElsewhere(artistId, 'faircamp', skippedHeldElsewhere);
    reportDiscardedReleases(artistId, 'faircamp', discarded);
    return written;
  } catch (error) {
    console.error('[DB] persistFaircampReleases error:', error);
    return [];
  }
}

/**
 * Write a Jam.coop catalog pass.
 *
 * Matches on `match_key` alone for the same reason `persistFaircampReleases` does: Jam.coop
 * files every release under `/albums/` and exposes no type field, so its inferred release type
 * is too weak to partition identity by, and partitioning by it would produce a duplicate row
 * every time Bandcamp had already typed the same record correctly.
 *
 * Where it differs from Faircamp is the date. Jam.coop publishes one on the album page, so this
 * fills `release_date`/`date_precision` on an existing row that lacks them — under the same
 * never-overwrite rules as everywhere else: a stored date wins over a new one, and a date the
 * artist curated is never touched at all.
 */
interface JamcoopReleaseToPersist {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  artworkUrl: string | null;
  externalUrl: string;
}

export async function persistJamcoopReleases(
  artistId: string,
  releases: JamcoopReleaseToPersist[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      .select('id, slug, match_key, release_type, release_date, date_precision, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistJamcoopReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];
    let discarded = 0;
    let skippedHeldElsewhere = 0;
    const heldElsewhere = await getListingsHeldElsewhere(client, 'jamcoop', releases.map(r => r.externalUrl), existing.map(r => r.id));

    for (const release of releases) {
      // The listing's own id first — see findReleaseBySource for the phantom rows this prevents.
      const prior =
        findReleaseBySource(existing, existingSources, 'jamcoop', release.externalUrl) ??
        findExactReleaseMatch(existing, release);

      let releaseId: string;
      let curatedFields: string[];
      let createdRow: ExistingRow | null = null;
      let fuzzyPartnerId: string | null = null;

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
          // Status is derived from the date, so the two move together — but only when this pass
          // is the one supplying the date. An existing dated row keeps whatever status its own
          // source derived, including an 'announced' from a real pre-order flag.
          patch.status = release.status;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistJamcoopReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        // Another artist's release holds this listing, so it can never be a source here.
        if (release.externalUrl && heldElsewhere.has(release.externalUrl)) {
          skippedHeldElsewhere++;
          continue;
        }

        const fuzzy = findFuzzyReleaseMatch(existing, release);

        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistJamcoopReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        createdRow = {
          id: releaseId,
          slug,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        existing.push(createdRow);
        fuzzyPartnerId = fuzzy?.id ?? null;
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        'jamcoop',
        release.externalUrl,
        release.externalUrl,
        existingSources
      );
      if (!source) {
        console.error('[DB] persistJamcoopReleases source write failed for release', releaseId);
        if (createdRow && (await discardUnsourcedRelease(client, releaseId, 'persistJamcoopReleases'))) {
          existing.splice(existing.indexOf(createdRow), 1);
          discarded++;
        }
        continue;
      }

      // Flagged only once the new row has its source, so a discarded row can't leave its
      // partner flagged against nothing.
      if (fuzzyPartnerId) {
        const { error: flagError } = await client
          .from('releases')
          .update({ needs_review: true, flagged_against_release_id: releaseId })
          .eq('id', fuzzyPartnerId);
        if (flagError) console.error('[DB] persistJamcoopReleases fuzzy-flag failed:', flagError.message);
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    logHeldElsewhere(artistId, 'jamcoop', skippedHeldElsewhere);
    reportDiscardedReleases(artistId, 'jamcoop', discarded);
    return written;
  } catch (error) {
    console.error('[DB] persistJamcoopReleases error:', error);
    return [];
  }
}

/**
 * Write a Mirlo catalog pass.
 *
 * Matches on `match_key` alone, for the same reason `persistJamcoopReleases` does: Mirlo
 * populates `type` on only a small minority of releases (5 of 209 measured live), so the stored
 * type is usually title-inferred and too weak to partition identity by. Partitioning on it would
 * mint a duplicate row every time Bandcamp had already typed the same record correctly.
 *
 * Dedup behaviour is the same as every other source: `findExactReleaseMatch` merges into the
 * existing row, `findFuzzyReleaseMatch` flags a pair for human review, and nothing new
 * auto-merges. Under-merge is preserved deliberately.
 *
 * Like Jam.coop, Mirlo publishes a date, so this fills `release_date`/`date_precision` on a row
 * that lacks them — under the usual never-overwrite rules: a stored date wins over a new one,
 * and a date the artist curated is never touched.
 */
interface MirloReleaseToPersistRow {
  title: string;
  slug: string;
  matchKey: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string;
  status: string;
  artworkUrl: string | null;
  externalUrl: string;
}

export async function persistMirloReleases(
  artistId: string,
  releases: MirloReleaseToPersistRow[]
): Promise<PersistedRelease[]> {
  const client = getClient();
  if (!client || releases.length === 0) return [];

  try {
    const { data: existingRows, error: readError } = await client
      .from('releases')
      .select('id, slug, match_key, release_type, release_date, date_precision, artwork_url, curated_fields')
      .eq('artist_id', artistId);

    if (readError) {
      console.error('[DB] persistMirloReleases read failed:', readError.message);
      return [];
    }

    type ExistingRow = {
      id: string;
      slug: string;
      match_key: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      curated_fields: string[] | null;
    };
    const existing = (existingRows as ExistingRow[]) || [];
    const takenSlugs = new Set(existing.map(r => r.slug));
    const existingSources = await getExistingSources(client, existing.map(r => r.id));

    const written: PersistedRelease[] = [];
    let discarded = 0;
    let skippedHeldElsewhere = 0;
    const heldElsewhere = await getListingsHeldElsewhere(client, 'mirlo', releases.map(r => r.externalUrl), existing.map(r => r.id));

    for (const release of releases) {
      // The listing's own id first — see findReleaseBySource for the phantom rows this prevents.
      const prior =
        findReleaseBySource(existing, existingSources, 'mirlo', release.externalUrl) ??
        findExactReleaseMatch(existing, release);

      let releaseId: string;
      let curatedFields: string[];
      let createdRow: ExistingRow | null = null;
      let fuzzyPartnerId: string | null = null;

      if (prior) {
        const curated = new Set(prior.curated_fields ?? []);
        curatedFields = [...curated];
        const patch: Record<string, unknown> = {};

        if (!curated.has('artwork_url') && release.artworkUrl && !prior.artwork_url) {
          patch.artwork_url = release.artworkUrl;
        }
        if (!curated.has('release_date') && release.releaseDate && !prior.release_date) {
          patch.release_date = release.releaseDate;
          patch.date_precision = release.datePrecision;
          // Status moves with the date, but only when this pass is the one supplying it. A row
          // that already had a date keeps whatever status its own source derived — including an
          // 'announced' from a real pre-order flag.
          patch.status = release.status;
        }

        if (Object.keys(patch).length > 0) {
          const { error } = await client.from('releases').update(patch).eq('id', prior.id);
          if (error) {
            console.error('[DB] persistMirloReleases update failed:', error.message);
            continue;
          }
        }
        releaseId = prior.id;
      } else {
        // Another artist's release holds this listing, so it can never be a source here.
        if (release.externalUrl && heldElsewhere.has(release.externalUrl)) {
          skippedHeldElsewhere++;
          continue;
        }

        const fuzzy = findFuzzyReleaseMatch(existing, release);

        let slug = release.slug;
        if (takenSlugs.has(slug)) slug = `${slug}-${release.matchKey.slice(0, 6)}`;
        takenSlugs.add(slug);

        const { data: inserted, error } = await client
          .from('releases')
          .insert({
            artist_id: artistId,
            title: release.title,
            slug,
            match_key: release.matchKey,
            release_type: release.releaseType,
            release_date: release.releaseDate,
            date_precision: release.datePrecision,
            status: release.status,
            artwork_url: release.artworkUrl,
            source: 'auto',
            ...(fuzzy && { needs_review: true, flagged_against_release_id: fuzzy.id }),
          })
          .select('id')
          .single();

        if (error || !inserted) {
          console.error('[DB] persistMirloReleases insert failed:', error?.message);
          continue;
        }
        releaseId = (inserted as { id: string }).id;
        curatedFields = [];

        createdRow = {
          id: releaseId,
          slug,
          match_key: release.matchKey,
          release_type: release.releaseType,
          release_date: release.releaseDate,
          date_precision: release.datePrecision,
          artwork_url: release.artworkUrl,
          curated_fields: [],
        };
        existing.push(createdRow);
        fuzzyPartnerId = fuzzy?.id ?? null;
      }

      const source = await upsertReleaseSource(
        client,
        releaseId,
        'mirlo',
        release.externalUrl,
        release.externalUrl,
        existingSources
      );
      if (!source) {
        console.error('[DB] persistMirloReleases source write failed for release', releaseId);
        if (createdRow && (await discardUnsourcedRelease(client, releaseId, 'persistMirloReleases'))) {
          existing.splice(existing.indexOf(createdRow), 1);
          discarded++;
        }
        continue;
      }

      // Flagged only once the new row has its source, so a discarded row can't leave its
      // partner flagged against nothing.
      if (fuzzyPartnerId) {
        const { error: flagError } = await client
          .from('releases')
          .update({ needs_review: true, flagged_against_release_id: releaseId })
          .eq('id', fuzzyPartnerId);
        if (flagError) console.error('[DB] persistMirloReleases fuzzy-flag failed:', flagError.message);
      }

      written.push({
        releaseId,
        sourceId: source.id,
        url: source.url,
        detailCheckedAt: source.detail_checked_at,
        curatedFields,
      });
    }

    logHeldElsewhere(artistId, 'mirlo', skippedHeldElsewhere);
    reportDiscardedReleases(artistId, 'mirlo', discarded);
    return written;
  } catch (error) {
    console.error('[DB] persistMirloReleases error:', error);
    return [];
  }
}

/**
 * Attach a source *discovered* on some other page (never fetched directly — see
 * `findDiscoveredReleaseLinks`) to an existing release, matched by **exact** normalized title.
 * Exact only, deliberately: a wrong attachment here would point a fan at a different record
 * than the one they're looking at, which is worse than never finding the link at all. Refuses
 * rather than guesses when the match key is ambiguous (two releases share it) or the release
 * already has a source for this platform.
 */
export async function attachDiscoveredSource(
  artistId: string,
  platform: string,
  url: string,
  matchKey: string
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { data, error } = await client
      .from('releases')
      .select('id, release_sources ( platform )')
      .eq('artist_id', artistId)
      .eq('match_key', matchKey);

    if (error) {
      console.error('[DB] attachDiscoveredSource read failed:', error.message);
      return false;
    }

    const matches = (data as { id: string; release_sources: { platform: string }[] | null }[]) || [];
    if (matches.length !== 1) return false; // no match, or ambiguous — never guess

    const release = matches[0];
    if ((release.release_sources || []).some(s => s.platform === platform)) return false;

    const { error: insertError } = await client.from('release_sources').insert({
      release_id: release.id,
      platform,
      url,
      external_id: null,
      source: 'auto',
    });

    if (insertError) {
      console.error('[DB] attachDiscoveredSource insert failed:', insertError.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] attachDiscoveredSource error:', error);
    return false;
  }
}
