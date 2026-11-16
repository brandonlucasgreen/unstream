// The Bandcamp slug-probe cache (bandcamp_slug_probes).

import { getClient } from './client';

// --- Bandcamp slug-probe cache (UNS-152) ---

export interface BandcampProbeRow {
  query_norm: string;
  artist_url: string | null;
  band_name: string | null;
  band_id: number | null;
  album_count: number;
  track_count: number;
  matched_slug: string | null;
  verdict: 'accepted' | 'absent' | 'rejected_empty' | 'rejected_name' | 'pending_review';
  /** Raw location string from the probed /music page, e.g. "Oxford, UK". */
  location: string | null;
  /** Normalized release titles from the probed /music page. */
  release_titles: string[] | null;
  /** Artist photo from the probed page's og:image. */
  image_url: string | null;
  /** The artist's sidebar bio. '' = checked, none shown; NULL = row predates bios. */
  bio: string | null;
  /**
   * The custom domain the account sits behind, when it has one. Written by the probe, not
   * read back: nothing needs it yet, and leaving it out of getBandcampProbe's select means a
   * read can't fail if this code deploys before its migration.
   */
  custom_domain?: string | null;
  /**
   * Slug candidates actually attempted in this probe round.
   *
   * `query_norm` strips punctuation, so "Morice" and "Mo-Rice" share one row —
   * but they generate different candidate sets (['morice'] vs
   * ['morice', 'mo-rice']). Without this, a negative recorded for the shorter
   * set is wrongly reused for the longer one, hiding a real artist. NULL means a
   * legacy row whose candidates are unknown.
   */
  probed_slugs: string[] | null;
  checked_at: string;
}

// Positives are stable — a Bandcamp URL rarely moves. Negatives expire, because
// an artist who wasn't on Bandcamp in March may well be by September.
const NEGATIVE_PROBE_TTL_DAYS = 30;

/**
 * True when a cached negative may be reused for a query that would probe `candidates`.
 *
 * A negative only means "none of the slugs we tried resolved". It says nothing about a
 * slug that was never tried — so it is reusable only if it covers every candidate the
 * current query would attempt. This is what keeps "Morice" (candidates ['morice'])
 * from answering for "Mo-Rice" (['morice', 'mo-rice']), which share a `query_norm`.
 *
 * A NULL `probed_slugs` is a pre-migration row: unknown coverage, so treat it as not
 * covering anything and let it be re-probed once.
 */
export function negativeCoversCandidates(
  probedSlugs: string[] | null,
  candidates: string[],
): boolean {
  if (!probedSlugs) return false;
  return candidates.every(c => probedSlugs.includes(c));
}

/**
 * Read a cached probe outcome. Returns null when there is no usable cache entry,
 * which is the caller's signal to probe.
 *
 * A stale negative returns null (re-probe); an accepted result never expires.
 * `pending_review` rows return as-is so an unverified account is neither
 * surfaced nor endlessly re-probed while it waits on /admin/verify.
 *
 * Pass `candidates` — the slugs this query would probe. A negative that does not
 * cover all of them is treated as a miss; see negativeCoversCandidates.
 */
export async function getBandcampProbe(
  queryNorm: string,
  candidates: string[] = [],
): Promise<BandcampProbeRow | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('bandcamp_slug_probes')
      .select('query_norm, artist_url, band_name, band_id, album_count, track_count, matched_slug, verdict, location, release_titles, image_url, bio, probed_slugs, checked_at')
      .eq('query_norm', queryNorm)
      .maybeSingle();

    if (error) {
      console.error('[DB] Failed to read bandcamp probe cache:', error);
      return null;
    }
    if (!data) return null;

    const row = data as BandcampProbeRow;
    if (row.verdict === 'accepted' || row.verdict === 'pending_review') return row;

    const ageMs = Date.now() - new Date(row.checked_at).getTime();
    if (ageMs > NEGATIVE_PROBE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;

    // A negative from a narrower candidate set must not answer for a wider one.
    if (candidates.length > 0 && !negativeCoversCandidates(row.probed_slugs, candidates)) {
      console.log(`[DB] Re-probing: cached negative covered ${row.probed_slugs?.length ?? 0} slug(s), query needs ${candidates.length}`);
      return null;
    }

    return row;
  } catch (error) {
    console.error('[DB] getBandcampProbe error:', error);
    return null;
  }
}

/**
 * Persist a probe outcome, positive or negative.
 *
 * Callers must never pass an undecided outcome. A network error, timeout or bot
 * challenge means we don't know — writing that as a negative would turn a
 * transient outage into a permanent "this artist isn't on Bandcamp". The DB's
 * own CHECK constraint has no 'undecided' value, so this is enforced twice.
 */
export async function putBandcampProbe(
  row: Omit<BandcampProbeRow, 'checked_at'>,
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    const { error } = await client
      .from('bandcamp_slug_probes')
      .upsert({ ...row, checked_at: new Date().toISOString() }, { onConflict: 'query_norm' });

    if (error) console.error('[DB] Failed to write bandcamp probe cache:', error);
  } catch (error) {
    console.error('[DB] putBandcampProbe error:', error);
  }
}
