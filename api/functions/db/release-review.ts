// The admin's side of release dedup: the tier-3 review queue and merging two releases.

import { getClient } from './client';

// --- Tier-3 dedup admin review queue ---
//
// The backstop the dedup scheme (spec §4) leans on once claiming is optional: ingest never
// auto-merges a fuzzy match, it only flags both sides via `needs_review` and
// `flagged_against_release_id`. These functions are the read side (list flagged pairs) and the
// two things an admin can do about one: say they're different (dismiss) or say they're the
// same (merge).

export interface ReleaseReviewItem {
  id: string;
  title: string;
  slug: string;
  releaseType: string;
  releaseDate: string | null;
  datePrecision: string | null;
  artworkUrl: string | null;
  artistName: string;
  artistSlug: string;
  platforms: string[];
}

/**
 * Fold a flat needs_review result set into pairs, deduplicating the two rows a symmetric flag
 * always produces (A flagged against B, and B flagged against A, are one pair to review, not
 * two). Pure and exported for tests — no network, no database.
 *
 * A row whose counterpart isn't in the set (already resolved from the other side, or deleted)
 * is still shown, alone, rather than dropped — something about it looked ambiguous enough to
 * flag, and silently hiding that is worse than showing it with nothing to compare against.
 */
export function pairReviewRows(
  rows: Map<string, ReleaseReviewItem & { flaggedAgainst: string | null }>
): { primary: ReleaseReviewItem; counterpart: ReleaseReviewItem | null }[] {
  const seen = new Set<string>();
  const pairs: { primary: ReleaseReviewItem; counterpart: ReleaseReviewItem | null }[] = [];

  for (const row of rows.values()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const counterpart = row.flaggedAgainst ? rows.get(row.flaggedAgainst) ?? null : null;
    if (counterpart) seen.add(counterpart.id);

    pairs.push({ primary: row, counterpart });
  }

  return pairs;
}

/**
 * Every release currently flagged for review, paired with its suspected duplicate where one is
 * still on file. Hidden releases are excluded — an admin has already ruled on those.
 */
export async function getReleaseReviewQueue(): Promise<
  { primary: ReleaseReviewItem; counterpart: ReleaseReviewItem | null }[]
> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('releases')
      .select(
        'id, title, slug, release_type, release_date, date_precision, artwork_url, flagged_against_release_id,' +
        ' artists ( name, slug ), release_sources ( platform )'
      )
      .eq('needs_review', true)
      .eq('is_hidden', false)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[DB] getReleaseReviewQueue failed:', error.message);
      return [];
    }

    type Row = {
      id: string;
      title: string;
      slug: string;
      release_type: string;
      release_date: string | null;
      date_precision: string | null;
      artwork_url: string | null;
      flagged_against_release_id: string | null;
      artists: { name: string; slug: string } | { name: string; slug: string }[] | null;
      release_sources: { platform: string }[] | null;
    };

    const rows = new Map<string, ReleaseReviewItem & { flaggedAgainst: string | null }>();

    for (const r of (data as unknown as Row[]) || []) {
      const artist = Array.isArray(r.artists) ? r.artists[0] : r.artists;
      rows.set(r.id, {
        id: r.id,
        title: r.title,
        slug: r.slug,
        releaseType: r.release_type,
        releaseDate: r.release_date,
        datePrecision: r.date_precision,
        artworkUrl: r.artwork_url,
        artistName: artist?.name ?? '(unknown)',
        artistSlug: artist?.slug ?? '',
        platforms: [...new Set((r.release_sources || []).map(s => s.platform))],
        flaggedAgainst: r.flagged_against_release_id,
      });
    }

    return pairReviewRows(rows);
  } catch (error) {
    console.error('[DB] getReleaseReviewQueue error:', error);
    return [];
  }
}

/**
 * "These are different releases." Clears the flag on both sides of the pair — including the
 * counterpart, looked up here rather than trusted from the client, since flagged_against_
 * release_id is what makes them a pair and both must stop pointing at the resolved question.
 */
export async function dismissReleaseReview(releaseId: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    const { data: row, error: readError } = await client
      .from('releases')
      .select('id, flagged_against_release_id')
      .eq('id', releaseId)
      .maybeSingle();

    if (readError || !row) {
      console.error('[DB] dismissReleaseReview read failed:', readError?.message ?? 'not found');
      return false;
    }

    const counterpartId = (row as { flagged_against_release_id: string | null }).flagged_against_release_id;
    const ids = counterpartId ? [releaseId, counterpartId] : [releaseId];

    const { error } = await client
      .from('releases')
      .update({ needs_review: false, flagged_against_release_id: null })
      .in('id', ids);

    if (error) {
      console.error('[DB] dismissReleaseReview update failed:', error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DB] dismissReleaseReview error:', error);
    return false;
  }
}

export interface MergeReleasesResult {
  ok: boolean;
  error?: string;
}

/**
 * "These are the same release." Moves every source off `dropId` onto `keepId`, fills in
 * whatever `keepId` is missing (date, artwork) without overwriting anything it already has or
 * anything an artist curated, then deletes the now-empty `dropId` row.
 *
 * Sources are moved **before** the duplicate row is deleted, and the delete is only attempted
 * once that move has succeeded — this project has already lost data once to a delete-before-a-
 * fallible-write (PR #350, an artist's links wiped by a preview), and a release merge is the
 * same shape of risk.
 *
 * Two sources on the same platform are carried over rather than refused, as long as the
 * platform's own ids tell them apart. That is the ordinary shape of the thing this queue is
 * mostly full of: Discogs holding two masters for one record, both of them real listings worth
 * keeping. What still stops the merge is a pair that *can't* be told apart — a source on a
 * shared platform with no external id on one side or the other — because the surviving row
 * could then hold two indistinguishable entries for one platform, and nothing downstream could
 * ever reconcile them.
 */
export async function mergeReleases(keepId: string, dropId: string): Promise<MergeReleasesResult> {
  const client = getClient();
  if (!client) return { ok: false, error: 'Database not configured' };
  if (keepId === dropId) return { ok: false, error: 'Cannot merge a release into itself' };

  try {
    // Both releases must belong to the same artist. The invariant lives *here*, not only at the
    // call sites, because a merge is close to irreversible — sources are moved and a row is
    // deleted — and the two callers reach it by different routes: the artist endpoint proves
    // ownership of both ids (`verifyReleaseOwnership`), while the admin endpoint passes ids
    // straight from a request body. Today the admin UI only ever submits pairs from the review
    // queue, which is same-artist by construction, but "no caller currently sends a mismatched
    // pair" is not something the database should be relying on.
    const { data: pair, error: pairError } = await client
      .from('releases')
      .select('id, artist_id')
      .in('id', [keepId, dropId]);

    if (pairError) {
      console.error('[DB] mergeReleases identity read failed:', pairError.message);
      return { ok: false, error: 'Failed to read releases' };
    }

    const rows = (pair as { id: string; artist_id: string }[] | null) || [];
    if (rows.length !== 2) return { ok: false, error: 'One or both releases could not be found' };
    if (rows[0].artist_id !== rows[1].artist_id) {
      // Deliberately not reported back with the artist ids in it — the caller supplied a pair
      // they had no business pairing, and echoing whose release the other one is would confirm
      // the existence of a row they can't otherwise see.
      console.error('[DB] mergeReleases refused a cross-artist merge');
      return { ok: false, error: 'Those releases belong to different artists' };
    }

    const [{ data: keepSources, error: keepError }, { data: dropSources, error: dropError }] = await Promise.all([
      client.from('release_sources').select('platform, external_id').eq('release_id', keepId),
      client.from('release_sources').select('id, platform, external_id').eq('release_id', dropId),
    ]);

    if (keepError || dropError) {
      console.error('[DB] mergeReleases read failed:', keepError?.message, dropError?.message);
      return { ok: false, error: 'Failed to read sources' };
    }

    const keep = (keepSources as { platform: string; external_id: string | null }[] | null) || [];
    const drop = (dropSources as { id: string; platform: string; external_id: string | null }[] | null) || [];

    const keepIdsByPlatform = new Map<string, (string | null)[]>();
    for (const source of keep) {
      const bucket = keepIdsByPlatform.get(source.platform);
      if (bucket) bucket.push(source.external_id);
      else keepIdsByPlatform.set(source.platform, [source.external_id]);
    }

    // Only an *indistinguishable* pair blocks. Two Discogs masters carry two ids and merge
    // fine; a source with no id on either side can't be separated from the one it would sit
    // beside, and `idx_release_sources_release_platform_external` would reject it anyway.
    const conflicting = drop.filter(source => {
      const keepIds = keepIdsByPlatform.get(source.platform);
      if (!keepIds) return false;
      return !source.external_id || keepIds.some(id => !id || id === source.external_id);
    });

    if (conflicting.length > 0) {
      const platforms = [...new Set(conflicting.map(c => c.platform))].join(', ');
      return { ok: false, error: `Both releases have an unidentified source on: ${platforms} — resolve manually` };
    }

    if (drop.length > 0) {
      const { error: moveError } = await client
        .from('release_sources')
        .update({ release_id: keepId })
        .eq('release_id', dropId);

      if (moveError) {
        console.error('[DB] mergeReleases move failed:', moveError.message);
        return { ok: false, error: 'Failed to move sources' };
      }
    }

    const anchors: Record<string, unknown> = {};

    const [{ data: keepRow }, { data: dropRow }] = await Promise.all([
      client.from('releases').select('release_date, artwork_url, curated_fields, discogs_master_id, musicbrainz_release_group_id').eq('id', keepId).maybeSingle(),
      client.from('releases').select('release_date, date_precision, artwork_url, discogs_master_id, musicbrainz_release_group_id').eq('id', dropId).maybeSingle(),
    ]);

    if (keepRow && dropRow) {
      const curated = new Set((keepRow as { curated_fields: string[] | null }).curated_fields ?? []);
      const patch: Record<string, unknown> = {};
      const keepFields = keepRow as {
        release_date: string | null;
        artwork_url: string | null;
        discogs_master_id: string | null;
        musicbrainz_release_group_id: string | null;
      };
      const dropFields = dropRow as {
        release_date: string | null;
        date_precision: string | null;
        artwork_url: string | null;
        discogs_master_id: string | null;
        musicbrainz_release_group_id: string | null;
      };

      if (!curated.has('release_date') && dropFields.release_date && !keepFields.release_date) {
        patch.release_date = dropFields.release_date;
        patch.date_precision = dropFields.date_precision;
      }
      if (!curated.has('artwork_url') && dropFields.artwork_url && !keepFields.artwork_url) {
        patch.artwork_url = dropFields.artwork_url;
      }
      if (Object.keys(patch).length > 0) {
        await client.from('releases').update(patch).eq('id', keepId);
      }

      // Identity anchors move across too, or the next catalogue pass finds no row for the
      // dropped master/release group and re-creates exactly what was just merged away. Where
      // the survivor already has one of its own, the dropped id still survives as the
      // `external_id` on the source row moved above, which is where ingest also looks.
      //
      // Written *after* the delete below, not here: both columns are covered by a unique index
      // per artist, so copying an id onto the survivor while the row it came from still holds
      // it is a constraint violation, not a merge.
      if (dropFields.discogs_master_id && !keepFields.discogs_master_id) {
        anchors.discogs_master_id = dropFields.discogs_master_id;
      }
      if (dropFields.musicbrainz_release_group_id && !keepFields.musicbrainz_release_group_id) {
        anchors.musicbrainz_release_group_id = dropFields.musicbrainz_release_group_id;
      }
    }

    // Safe now: every source under dropId has been moved (or there were none), and the
    // conflict check above means nothing was left behind to lose.
    const { error: deleteError } = await client.from('releases').delete().eq('id', dropId);
    if (deleteError) {
      console.error('[DB] mergeReleases delete failed:', deleteError.message);
      return { ok: false, error: 'Sources moved, but failed to remove the duplicate row' };
    }

    const { error: clearError } = await client
      .from('releases')
      .update({ needs_review: false, flagged_against_release_id: null, ...anchors })
      .eq('id', keepId);
    if (clearError) console.error('[DB] mergeReleases clear-flag failed:', clearError.message);

    return { ok: true };
  } catch (error) {
    console.error('[DB] mergeReleases error:', error);
    return { ok: false, error: 'Unexpected error' };
  }
}
