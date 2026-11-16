// Catalogue state and the sweep: claiming an artist for a pass, recording its outcome, choosing
// who the sweep refreshes next, and reading the artist a pass works on.

import { isBandcampSearchLink } from '../search-utils';
import { CATALOGUEABLE_PLATFORMS } from '../catalogueable-platforms';
import { notifySavedArtistsOfNewRelease } from '../notifications';
import { Sentry } from '../../lib/sentry';
import { getClient } from './client';

// --- Release catalog (Unstream Releases) ---

/** Don't re-crawl an artist inside this window. Repeat searches then cost nothing upstream. */
export const RECATALOG_COOLDOWN_HOURS = 24 * 7;

/**
 * Hourly ceilings on how many artists we will catalog, by what triggered it.
 *
 * A save is one person deliberately asking to follow an artist, so it gets the biggest budget
 * and still gets through when the scheduled sweep is being dropped. The sweep sits below it:
 * the cap is compared against every attempt in the last hour whatever triggered it, so a
 * machine caller must never outrank a person, but the sweep runs at a fixed time and can't
 * wait for a quieter moment, so it can't have the smallest either.
 *
 * `searched` has no caller any more — `persistSearchResults` no longer requests cataloging,
 * because an unauthenticated, traffic-driven trigger at 60 first-time crawls an hour was what
 * exhausted the Supabase disk I/O budget (see that function's comment). The entry stays because
 * it is the fail-closed default the background function falls back to for an unrecognized
 * trigger, and it is the smallest budget of the three. Adding a caller back means re-doing the
 * arithmetic in docs/specs/supabase-disk-io-investigation.md first.
 */
const CATALOG_HOURLY_CAP = { searched: 60, saved: 240, scheduled: 120 } as const;

export type CatalogTrigger = 'saved' | 'searched' | 'scheduled';

/**
 * May we catalog this artist right now — and if so, claim it.
 *
 * Cooldown, then hourly cap, then stamp `last_attempted_at`. The stamp is the claim: two
 * near-simultaneous triggers for the same artist won't both do the work, because the second
 * sees a fresh attempt timestamp.
 *
 * Returns false on any error. Cataloging is opportunistic — if we can't tell whether it's
 * allowed, not crawling is the safe answer, and the next search or save tries again.
 */
export async function claimArtistForCatalog(
  artistId: string,
  trigger: CatalogTrigger
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { data: state, error: stateError } = await client
      .from('release_catalog_state')
      .select('last_catalogued_at, last_attempted_at, consecutive_failures')
      .eq('artist_id', artistId)
      .maybeSingle();

    if (stateError) {
      console.error('[DB] claimArtistForCatalog read failed:', stateError.message);
      return false;
    }

    const now = Date.now();
    const row = state as
      | { last_catalogued_at: string | null; last_attempted_at: string; consecutive_failures: number }
      | null;

    if (row) {
      // Already catalogued recently.
      if (row.last_catalogued_at) {
        const age = now - new Date(row.last_catalogued_at).getTime();
        if (age < RECATALOG_COOLDOWN_HOURS * 3600_000) return false;
      }

      // Someone else claimed it moments ago, or a failing artist is backing off. The backoff
      // doubles per consecutive failure so a permanently broken artist isn't retried on every
      // single search, capped so it eventually recovers.
      const attemptAge = now - new Date(row.last_attempted_at).getTime();
      const backoffMs = Math.min(2 ** Math.min(row.consecutive_failures, 6), 64) * 15 * 60_000;
      if (attemptAge < Math.max(backoffMs, 60_000)) return false;
    }

    // Hourly cap, counted across all artists.
    const since = new Date(now - 3600_000).toISOString();
    const { count, error: countError } = await client
      .from('release_catalog_state')
      .select('artist_id', { count: 'exact', head: true })
      .gte('last_attempted_at', since);

    if (countError) {
      console.error('[DB] claimArtistForCatalog count failed:', countError.message);
      return false;
    }
    if ((count ?? 0) >= CATALOG_HOURLY_CAP[trigger]) {
      console.log(`[catalog] hourly cap reached for trigger=${trigger} (${count}) — skipping`);
      return false;
    }

    const { error: claimError } = await client
      .from('release_catalog_state')
      .upsert(
        { artist_id: artistId, last_attempted_at: new Date(now).toISOString(), last_trigger: trigger },
        { onConflict: 'artist_id' }
      );

    if (claimError) {
      console.error('[DB] claimArtistForCatalog claim failed:', claimError.message);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[DB] claimArtistForCatalog error:', error);
    return false;
  }
}

/** Record the outcome of a catalog run. Failures increment the backoff counter. */
export async function recordCatalogOutcome(
  artistId: string,
  outcome: { releasesFound: number; releasesDetailed?: number } | { error: string }
): Promise<void> {
  const client = getClient();
  if (!client) return;

  const patch: Record<string, unknown> =
    'error' in outcome
      ? { last_error: outcome.error.slice(0, 500) }
      : {
          last_catalogued_at: new Date().toISOString(),
          releases_found: outcome.releasesFound,
          releases_detailed: outcome.releasesDetailed ?? 0,
          consecutive_failures: 0,
          last_error: null,
        };

  try {
    if ('error' in outcome) {
      // Read-then-increment rather than a raw SQL expression, to stay within the JS client.
      const { data } = await client
        .from('release_catalog_state')
        .select('consecutive_failures')
        .eq('artist_id', artistId)
        .maybeSingle();
      const prev = (data as { consecutive_failures: number } | null)?.consecutive_failures ?? 0;
      patch.consecutive_failures = prev + 1;
    } else {
      // Read once and branch: a drop to zero is a parser/bot-challenge alert (see below), an
      // increase is news for anyone who saved this artist. Fetched for every successful run,
      // not just the sweep, since demand-driven catalog triggers (a save, a search) are exactly
      // where a fan is most likely to be waiting on this.
      const { data } = await client
        .from('release_catalog_state')
        .select('releases_found')
        .eq('artist_id', artistId)
        .maybeSingle();
      const previous = (data as { releases_found: number | null } | null)?.releases_found ?? 0;

      if (outcome.releasesFound === 0 && previous > 0) {
        // A run that finds 0 releases where it previously found 20 is a parser break or a bot
        // challenge, not an artist deleting their catalogue — and it is recorded as a *success*,
        // so nothing else about it looks wrong. Report the transition, because the alternative
        // is a pipeline that degrades into finding nothing and never says so.
        //
        // Only the transition: an artist who has always had 0 releases is not news, and this
        // fires on every trigger, not just the scheduled sweep.
        Sentry.captureMessage('[catalog] release count dropped to zero', {
          level: 'warning',
          tags: { area: 'release-catalog', kind: 'releases-dropped-to-zero' },
          extra: { artistId, previousReleasesFound: previous },
        });
      } else if (outcome.releasesFound > previous) {
        // Fire-and-forget: notifySavedArtistsOfNewRelease decides for itself whether there is
        // anything to say (it sends nothing unless this run turned up a release that is both
        // unannounced and actually recent) and logs its own failures to Sentry — a notification
        // email must never affect cataloging's own success/failure. The count comparison here is
        // only a cheap gate: a total that didn't go up can't have added rows worth claiming.
        void notifySavedArtistsOfNewRelease({ client, artistId }).catch(err => {
          Sentry.captureException(err, { extra: { context: 'notifySavedArtistsOfNewRelease', artistId } });
        });
      }
    }

    const { error } = await client
      .from('release_catalog_state')
      .update(patch)
      .eq('artist_id', artistId);

    if (error) console.error('[DB] recordCatalogOutcome failed:', error.message);
  } catch (error) {
    console.error('[DB] recordCatalogOutcome error:', error);
  }
}

export interface CatalogStateRow {
  last_catalogued_at: string | null;
  last_attempted_at: string;
  releases_found: number | null;
  releases_detailed: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

/**
 * Deliberately three-valued, not two. "We couldn't ask" and "we asked and this artist has never
 * been catalogued" are different facts, and collapsing them into one `null` makes a broken
 * database read render as a confident "Never catalogued" — the same shape as the bug class the
 * "never cache uncertainty" principle exists to prevent. Every surface that reports cataloging
 * exists to make it observable, so an unreadable state has to say so rather than guess.
 */
export type CatalogStateResult =
  | { ok: true; state: CatalogStateRow | null }
  | { ok: false; reason: string };

export async function getCatalogState(artistId: string): Promise<CatalogStateResult> {
  const client = getClient();
  if (!client) return { ok: false, reason: 'Supabase is not configured on this deploy' };

  const { data, error } = await client
    .from('release_catalog_state')
    .select('last_catalogued_at, last_attempted_at, releases_found, releases_detailed, last_error, consecutive_failures')
    .eq('artist_id', artistId)
    .maybeSingle();

  if (error) {
    console.error('[DB] getCatalogState failed:', error.message);
    return { ok: false, reason: 'Could not read catalog state' };
  }
  return { ok: true, state: (data as CatalogStateRow | null) ?? null };
}

/** One artist the scheduled sweep could crawl, with the facts it was chosen on. */
export interface StaleCatalogCandidate {
  artistId: string;
  /** Somebody has this artist saved, so an alert depends on this catalogue being current. */
  saved: boolean;
  /** The artist has a verified claim on their profile, so the catalogue is their own promotion. */
  claimed: boolean;
  /** Somebody's connected Bandcamp collection holds one of their records. */
  collected: boolean;
  /** How many people have them saved. A tiebreak only — see the sort below. */
  savers: number;
  /** Null means no catalog run has ever claimed them: this is coverage, not refresh. */
  lastAttemptedAt: string | null;
  /** What the last successful run found, so a sweep run can be read against it afterwards. */
  releasesFound: number | null;
}

/**
 * Three-valued for the same reason as `CatalogStateResult`: "we couldn't ask" must not render
 * as "nothing needs re-cataloguing". The sweep reports the first as a failure and the second as
 * a quiet, successful run, and they look identical if collapsed.
 */
export type StaleCatalogResult =
  | {
      ok: true;
      candidates: StaleCatalogCandidate[];
      /** Artists with something to crawl — the pool, not the batch. */
      catalogueable: number;
      /** How many of those are saved by somebody. */
      savedArtists: number;
      /** How many of those have a verified claim. */
      claimedArtists: number;
      /** How many of those appear in somebody's connected collection. */
      collectedArtists: number;
      /**
       * In the pool but never successfully catalogued, and nobody has saved, claimed or
       * collected them — so the sweep leaves them alone. The searched-but-unwanted tail,
       * counted so the log shows it rather than hiding it inside `eligible`.
       */
      awaitingDemand: number;
      /**
       * Already catalogued, but nobody has saved, claimed or collected them — so the sweep
       * has stopped *refreshing* them (disk I/O round 6, 2026-09-19). Their `release_catalog_state`
       * row stays and their page keeps rendering the frozen catalogue; the prices on it just
       * stop being updated. Counted separately from `awaitingDemand` so the log shows how many
       * catalogues froze rather than folding them into the never-catalogued tail.
       */
      frozenCatalogues: number;
      /** Dropped because they were catalogued inside the cooldown. */
      inCooldown: number;
      /** Eligible right now, of which only `limit` fit in this batch. */
      eligible: number;
    }
  | { ok: false; reason: string };

/**
 * The single row `stale_catalog_candidates()` returns, in its own snake_case.
 *
 * Kept separate from `StaleCatalogResult` on purpose: this is the database's shape and that is
 * the sweep's, and writing the mapping out is what makes a column rename in the migration a
 * compile-time problem here rather than an `undefined` in the sweep's log.
 */
interface StaleCatalogRow {
  catalogueable: number;
  saved_artists: number;
  claimed_artists: number;
  collected_artists: number;
  awaiting_demand: number;
  frozen_catalogues: number;
  in_cooldown: number;
  eligible: number;
  candidates: {
    artist_id: string;
    saved: boolean;
    claimed: boolean;
    collected: boolean;
    savers: number;
    last_attempted_at: string | null;
    releases_found: number | null;
  }[] | null;
}

/**
 * Whether a stored link is something the catalog pass can actually crawl.
 *
 * The platform being catalogue-able is not enough: a `bandcamp` row may hold
 * `https://bandcamp.com/search?q=<name>`, the "go search Bandcamp yourself" placeholder that
 * `attachAmpwallAndSearchLinks` writes when nothing resolved a real artist page. It is a UI
 * affordance, not an artist link, and `bandcampMusicUrl()` reduces any URL to its origin plus
 * `/music` — so every one of them derives `https://bandcamp.com/music`, which 404s. Measured
 * 2026-08-03: 189 such rows, and the 16 that had been swept were the *only* failures in
 * `release_catalog_state`, each climbing a backoff it could never escape.
 *
 * `getArtistForCatalog` applies this so `catalogArtist` never fails on a link there was no point
 * fetching. The sweep's pool needs the same rule, and since 2026-10-19 applies it in SQL instead
 * (`NOT (platform = 'bandcamp' AND url LIKE '%bandcamp.com/search%')` in
 * `stale_catalog_candidates`), so the two must now be changed together by hand — the migration's
 * header says so from its side.
 */
function isCatalogueableLink(platform: string, url: string): boolean {
  if (platform === 'bandcamp') return !isBandcampSearchLink(url);
  return true;
}

/**
 * The artists whose release catalogue most needs building or refreshing.
 *
 * **The sweep's attention is demand-gated: a save, a verified claim, or a connected
 * collection.** An artist gets a *first* catalogue here only if a fan has saved them, a fan's
 * connected Bandcamp collection holds one of their records, or the artist has a verified
 * claim (disk I/O round 5, 2026-09-13) — and since round 6 (2026-09-19) the same three
 * signals gate the *refresh* too. An already-catalogued artist nobody follows is frozen
 * rather than re-crawled: their `release_catalog_state` row stays and their page keeps
 * rendering the stored catalogue, but its prices stop being updated. The alternative was
 * keeping every artist search ever resolved in the 7-day rotation forever, and the I/O from
 * that rotation wedged the instance on 2026-09-19.
 *
 * The pool used to be every artist with a catalogue-able link, so that `/a/:slug` could show
 * releases for anyone ever searched. That made the pool a function of search traffic:
 * `persistSearchResults` stores a link row for every artist a search resolves, and measured
 * 2026-09-12 the pool was growing by ~46 artists a day against a sweep of 50, so 21–23 of every
 * 25 picked were first-time catalogues — the expensive case, forever — and the Supabase disk
 * I/O warning came back a week after round 4 halved the cadence. Search still decided what got
 * catalogued, one step removed from the `searched` trigger round 3 removed. Full arithmetic in
 * docs/specs/supabase-disk-io-investigation.md ("Round 5"). The product judgement behind
 * gating on demand rather than on page views: a big artist's discography is a click away on
 * Bandcamp or Qobuz, and the release pages earn their keep for the small, claimed artists
 * promoting their own work.
 *
 * Ordering, in priority order:
 *
 *   1. **Saved, collected and claimed artists first.** An alert is a promise to a person, a
 *      collection is a record somebody paid for, and a claimed catalogue is the artist's own
 *      promotion, so none of them can starve behind the refresh of anyone else. The demand
 *      gate currently makes this the whole batch; the tier stays so that relaxing the gate
 *      (page-view demand, say) can never silently deprioritise fans.
 *   2. **Then never catalogued.** No state row at all means we have no releases for them, which
 *      is worse than having slightly old ones.
 *   3. **Then stalest `last_attempted_at`.** Staleness is what makes alerts go quiet and artist
 *      pages go out of date, so it is what the sweep is for.
 *   4. **Then most savers.** A tiebreak only. Sorting by popularity any higher would starve
 *      exactly the long tail this exists to serve — popular artists already stay fresh because
 *      people search them.
 *
 * Artists inside the re-catalog cooldown are dropped here rather than left for
 * `claimArtistForCatalog` to refuse. That's not a second rate limiter — the same constant, read
 * up front — it's what stops a bounded batch being spent entirely on artists that will be
 * refused a moment later. The claim remains the authority; this only decides who to ask about.
 *
 * ## All of that now happens in SQL (2026-10-19)
 *
 * The rules above are implemented by `stale_catalog_candidates()`
 * (`supabase/migrations/20261019120000_stale-catalog-candidates.sql`), which this function does
 * nothing but call and map. **Change them there**, and read that migration's header before you
 * do: it spells out which details are load-bearing.
 *
 * It used to do the work here, across six paged reads — every catalogue-able `artist_links` row,
 * every undeleted save, every verified profile, every `collection_items` slug, those slugs
 * resolved against `artists` in chunks, and the whole of `release_catalog_state` — combined with
 * Sets and Maps. On the 2026-10-18 pool (`catalogueable: 5749`) that was over ten thousand rows
 * serialised to JSON across ~20 PostgREST round trips to choose 25 ids.
 *
 * Disk I/O round 1 measured that and **dropped it as immaterial**, which was right: ~32 reads a
 * day is nothing against an IOPS budget. Round 7 (2026-10-18) then measured the instance and
 * found the real ceiling is memory — ~1.27 GB committed against ~1.25 GB, ~400 MB swapped, flat
 * around the clock — which is a constraint those six full scans and that JSON do press on. The
 * scans still happen inside Postgres; what stops is the rows leaving it. Measured on Postgres 16
 * with the pool above: one call, 1,440 shared buffers, ~6 ms.
 *
 * `RECATALOG_COOLDOWN_HOURS` and `CATALOGUEABLE_PLATFORMS` are passed in rather than restated in
 * SQL, so they keep one definition each.
 */
export async function getStaleCatalogCandidates(limit: number): Promise<StaleCatalogResult> {
  const client = getClient();
  if (!client) return { ok: false, reason: 'Supabase is not configured on this deploy' };

  const { data, error } = await client.rpc('stale_catalog_candidates', {
    p_limit: limit,
    p_cooldown_hours: RECATALOG_COOLDOWN_HOURS,
    p_platforms: CATALOGUEABLE_PLATFORMS as unknown as string[],
  });

  if (error) {
    console.error('[DB] stale catalog candidates read failed:', error.message);
    return { ok: false, reason: `Could not select catalogue candidates: ${error.message}` };
  }

  // PostgREST returns a set-returning function as an array; this one returns exactly one row.
  // No row is not an empty pool — an empty pool is a row of zeros — so it is a failure, for the
  // same reason the result type is three-valued: "we couldn't ask" must not read as "nothing to
  // do", which the sweep would report as a quiet, successful run.
  const row = (data as StaleCatalogRow[] | null)?.[0];
  if (!row) {
    console.error('[DB] stale catalog candidates returned no row');
    return { ok: false, reason: 'Candidate selection returned no row' };
  }

  return {
    ok: true,
    candidates: (row.candidates ?? []).map(c => ({
      artistId: c.artist_id,
      saved: c.saved,
      claimed: c.claimed,
      collected: c.collected,
      savers: c.savers,
      lastAttemptedAt: c.last_attempted_at,
      releasesFound: c.releases_found,
    })),
    catalogueable: row.catalogueable,
    savedArtists: row.saved_artists,
    claimedArtists: row.claimed_artists,
    collectedArtists: row.collected_artists,
    awaitingDemand: row.awaiting_demand,
    frozenCatalogues: row.frozen_catalogues,
    inCooldown: row.in_cooldown,
    eligible: row.eligible,
  };
}

/**
 * Clear an artist's cooldown so a deliberately-requested crawl actually runs.
 *
 * Without it a "catalog now" control would appear to work and do nothing for a week —
 * `claimArtistForCatalog` refuses an artist catalogued in the last 7 days, which is right for
 * demand-driven triggers and wrong for someone deliberately asking.
 *
 * Backdated rather than deleted: the row also carries the failure counter and the last error,
 * which are worth keeping. Two hours clears both the cooldown and the exponential backoff.
 */
export async function clearCatalogCooldown(artistId: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { error } = await client
    .from('release_catalog_state')
    .update({ last_catalogued_at: null, last_attempted_at: twoHoursAgo, consecutive_failures: 0 })
    .eq('artist_id', artistId);

  if (error) console.error('[DB] clearCatalogCooldown failed:', error.message);
}

/**
 * Mark every one of an artist's sources as never priced, so a deliberately-requested crawl
 * re-reads the release pages instead of only the grid.
 *
 * **Clearing the artist's cooldown alone is not enough**, and the gap is invisible: the crawl
 * runs, reports success, and changes nothing an artist can see. Dates, formats and prices live
 * only on individual release pages, and both detail passes skip a source that was already read —
 * Bandcamp's within `DETAIL_REFRESH_DAYS`, Discogs' ever. That refresh rule is right for the
 * demand-driven crawl it was written for, where re-reading every page weekly would triple the
 * request count for data that rarely moves. It is wrong for someone standing in front of the
 * button having just been told their prices are wrong: found once, in exactly that situation,
 * when a parser fix for a bad Bandcamp price shipped and re-cataloguing didn't apply it.
 *
 * Null, not backdated: "never read" is the honest state for a source whose stored price we've
 * decided not to trust, and it's what both passes already test for.
 */
export async function clearReleaseDetailCooldown(artistId: string): Promise<void> {
  const client = getClient();
  if (!client) return;

  const { data, error: readError } = await client.from('releases').select('id').eq('artist_id', artistId);
  if (readError) {
    console.error('[DB] clearReleaseDetailCooldown read failed:', readError.message);
    return;
  }

  const releaseIds = ((data as { id: string }[] | null) || []).map(r => r.id);
  if (releaseIds.length === 0) return;

  const { error } = await client
    .from('release_sources')
    .update({ detail_checked_at: null })
    .in('release_id', releaseIds);

  if (error) console.error('[DB] clearReleaseDetailCooldown failed:', error.message);
}

/** What the catalog passes need before they can start. */
export interface ArtistForCatalog {
  name: string;
  /** The photo search stored, which the Bandcamp pass replaces if its host has deleted it. */
  imageUrl: string | null;
  /** A claimed artist's own photo. Shown instead of `imageUrl` wherever there is one. */
  customImageUrl: string | null;
  bandcampUrl: string | null;
  discogsUrl: string | null;
  faircampUrl: string | null;
  jamcoopUrl: string | null;
  mirloUrl: string | null;
  officialSiteUrl: string | null;
}

/**
 * One read for everything cataloging needs to know about an artist: the display name
 * (Discogs and MusicBrainz are both looked up by name, not by a stored id) plus whichever of
 * the known links are on file. Returns null only when the artist row itself is missing — a
 * source link being absent is a normal, independent per-source outcome, not a reason to fail
 * the whole lookup.
 */
export async function getArtistForCatalog(artistId: string): Promise<ArtistForCatalog | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const [{ data: artistRow, error: artistError }, { data: linkRows, error: linkError }] = await Promise.all([
      client.from('artists').select('name, image_url, artist_profiles(custom_image_url)').eq('id', artistId).maybeSingle(),
      client
        .from('artist_links')
        .select('platform, url')
        .eq('artist_id', artistId)
        .in('platform', [...CATALOGUEABLE_PLATFORMS, 'officialsite']),
    ]);

    if (artistError || !artistRow) {
      if (artistError) console.error('[DB] getArtistForCatalog artist read failed:', artistError.message);
      return null;
    }
    if (linkError) console.error('[DB] getArtistForCatalog link read failed:', linkError.message);

    // A placeholder search link is dropped here rather than handed to the crawler, so an artist
    // whose only Bandcamp row is one falls through to catalogArtist's "nothing stored" branch
    // instead of failing on a 404 forever. `officialsite` is not catalogue-able on its own and
    // is filtered by platform above, so it needs no URL-shape check.
    const links = ((linkRows as { platform: string; url: string }[] | null) || []).filter(l =>
      isCatalogueableLink(l.platform, l.url)
    );
    const row = artistRow as {
      name: string;
      image_url: string | null;
      artist_profiles: { custom_image_url: string | null } | { custom_image_url: string | null }[] | null;
    };
    // artist_id is unique on artist_profiles, so PostgREST embeds one object (null when unclaimed).
    // An array is accepted too: misreading the shape would silently ignore an artist's own photo.
    const profile = Array.isArray(row.artist_profiles) ? row.artist_profiles[0] : row.artist_profiles;
    return {
      name: row.name,
      imageUrl: row.image_url,
      customImageUrl: profile?.custom_image_url ?? null,
      bandcampUrl: links.find(l => l.platform === 'bandcamp')?.url ?? null,
      discogsUrl: links.find(l => l.platform === 'discogs')?.url ?? null,
      faircampUrl: links.find(l => l.platform === 'faircamp')?.url ?? null,
      jamcoopUrl: links.find(l => l.platform === 'jamcoop')?.url ?? null,
      mirloUrl: links.find(l => l.platform === 'mirlo')?.url ?? null,
      officialSiteUrl: links.find(l => l.platform === 'officialsite')?.url ?? null,
    };
  } catch (error) {
    console.error('[DB] getArtistForCatalog error:', error);
    return null;
  }
}

/**
 * Replace an artist's stored photo, but only if it is still the one the caller found gone: a search
 * that stored a new photo in the meantime wins. The one write the catalogue pass makes to a claimed
 * artist's row, and safe for the same reason it's allowed: `image_url` is what search found, never
 * something the artist chose (theirs is `artist_profiles.custom_image_url`, which this doesn't touch).
 * Leaves `updated_at` alone, since it means "last verified against live sources", not "changed".
 *
 * Returns whether a row changed.
 */
export async function replaceArtistPhoto(artistId: string, goneUrl: string, newUrl: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  const { data, error } = await client
    .from('artists')
    .update({ image_url: newUrl })
    .eq('id', artistId)
    .eq('image_url', goneUrl)
    .select('id');

  if (error) {
    console.error('[DB] replaceArtistPhoto failed:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
