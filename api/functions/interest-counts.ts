// Reads for "I'd tip them" and Play my city counts (docs/specs/artist-patronage-spec.md §3.5, §3.6).
// Kept out of db.ts, which is already the largest file in the backend; the writes live in
// artist-interest.ts, the one endpoint that makes them.

import { getClient } from './db';
import { Sentry } from '../lib/sentry';
import {
  PUBLIC_CITY_LIMIT,
  PUBLIC_INTEREST_THRESHOLD,
  parseInterestRow,
  type InterestCounts,
} from '../shared/artist-interest';

/** A search page or an artist page; anything longer is a caller bug, not a bigger query. */
const MAX_SLUGS = 50;

export interface CountOptions {
  /** Display threshold. Public surfaces use PUBLIC_INTEREST_THRESHOLD; the owner's dashboard 1. */
  min: number;
  limit: number;
}

export const PUBLIC_COUNTS: CountOptions = { min: PUBLIC_INTEREST_THRESHOLD, limit: PUBLIC_CITY_LIMIT };
export const DASHBOARD_COUNTS: CountOptions = { min: 1, limit: 10 };

/**
 * Counts for each slug that has any interest at all; slugs with none are absent from the map.
 *
 * Returns null when the read fails, so a caller can tell "nobody asked" from "we couldn't
 * check" — the counts are decoration on search and the artist page, so both callers carry on
 * without them, but the failure is reported rather than rendered as silence.
 */
export async function getArtistInterestCounts(
  slugs: string[],
  opts: CountOptions,
): Promise<Map<string, InterestCounts> | null> {
  const unique = [...new Set(slugs.filter(s => typeof s === 'string' && s.length > 0))].slice(0, MAX_SLUGS);
  const result = new Map<string, InterestCounts>();
  if (unique.length === 0) return result;

  // Never throws: search awaits this on every request, and a counts failure must not become a
  // failed search.
  let data: unknown;
  try {
    const client = getClient();
    if (!client) return null;
    const res = await client.rpc('get_artist_interest_counts', {
      p_slugs: unique,
      p_min: opts.min,
      p_limit: opts.limit,
    });
    if (res.error) throw new Error(res.error.message);
    data = res.data;
  } catch (err) {
    Sentry.captureMessage('[interest-counts] get_artist_interest_counts failed', {
      level: 'error',
      extra: { context: 'interest-counts.read', error: String(err), slugCount: unique.length },
    });
    return null;
  }

  for (const row of (data ?? []) as Array<{ slug: string; tip_count: unknown; cities: unknown }>) {
    result.set(row.slug, parseInterestRow(row));
  }
  return result;
}

/** Cities at least three fans have named, starting with `prefix` (already a cityKey). */
export async function getCitySuggestions(prefix: string): Promise<string[] | null> {
  const client = getClient();
  if (!client) return null;
  const { data, error } = await client.rpc('get_city_suggestions', { p_prefix: prefix, p_limit: 8 });
  if (error) {
    Sentry.captureMessage('[interest-counts] get_city_suggestions failed', {
      level: 'warning',
      extra: { context: 'interest-counts.suggest', error: error.message },
    });
    return null;
  }
  return ((data ?? []) as Array<{ city_label: string }>).map(r => r.city_label);
}
