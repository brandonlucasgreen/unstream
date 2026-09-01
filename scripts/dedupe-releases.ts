#!/usr/bin/env npx tsx
/**
 * Apply the current dedup rules to the releases already in the catalog.
 *
 * Ingest only ever compares a release it is *writing* against what is already stored, so
 * changing the rules fixes tomorrow and leaves yesterday exactly as it was. Measured
 * 2026-08-29, yesterday holds:
 *
 *   - 1,181 pairs of releases under one artist with a byte-identical `match_key`, 931 of them
 *     with no date saying they are different. Almost none were ever flagged, because flagging
 *     was scoped to a release type and Discogs types 92% of its rows 'other'. They are simply
 *     sitting on artist pages twice.
 *   - review flags on pairs whose release dates positively disagree — the fuzzy title matcher's
 *     false positives, which are now vetoed on the way in but still queued from before.
 *
 * Two passes, both of which print what they would do and change nothing without `--write`:
 *
 *   npx tsx scripts/dedupe-releases.ts                  # report only (default)
 *   npx tsx scripts/dedupe-releases.ts --write          # apply
 *   npx tsx scripts/dedupe-releases.ts --limit=10       # try a small slice first
 *   npx tsx scripts/dedupe-releases.ts --merges-only    # skip the review-flag pass
 *   npx tsx scripts/dedupe-releases.ts --flags-only     # skip the merge pass
 *
 * Merging is done through `mergeReleases` from db.ts — the same function the admin queue calls,
 * not a copy of it. That matters more than the convenience: a merge moves source rows and then
 * deletes a release, and this script would be doing it ~900 times unattended. Every guard the
 * interactive path has (same artist, no indistinguishable sources on a shared platform, sources
 * moved before anything is deleted) applies here unchanged, and a pair it refuses is reported
 * rather than forced.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY (or a .env at the repo root).
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'path';
import { mergeReleases, dismissReleaseReview } from '../api/functions/db';
import { releaseDatesDisagree } from '../api/functions/release-utils';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Set them in .env or environment.');
  process.exit(1);
}
const client = createClient(url, key);

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const MERGES_ONLY = args.includes('--merges-only');
const FLAGS_ONLY = args.includes('--flags-only');
const LIMIT = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

interface ReleaseRow {
  id: string;
  artist_id: string;
  title: string;
  match_key: string;
  release_type: string;
  release_date: string | null;
  date_precision: string | null;
  created_at: string;
  needs_review: boolean;
  flagged_against_release_id: string | null;
  artists: { name: string } | { name: string }[] | null;
}

/** PostgREST caps every response at 1,000 rows and truncates silently. */
async function readAll<T>(table: string, select: string): Promise<T[]> {
  const PAGE = 1_000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select(select).order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const batch = (data as T[]) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

function artistName(row: ReleaseRow): string {
  const a = Array.isArray(row.artists) ? row.artists[0] : row.artists;
  return a?.name ?? '(unknown artist)';
}

function dateFacts(row: ReleaseRow) {
  return { date: row.release_date, precision: row.date_precision };
}

/**
 * Which row of a duplicate group survives.
 *
 * Most sources first — the survivor should be the row a fan is most likely to have reached,
 * and it keeps the merge from having to move as much. Then a real day-precision date over
 * Discogs' padded January 1st. Then the oldest, so the URL that has existed longest is the one
 * that keeps existing.
 */
function pickKeeper(group: ReleaseRow[], sourceCounts: Map<string, number>): ReleaseRow {
  return [...group].sort((a, b) => {
    const sources = (sourceCounts.get(b.id) ?? 0) - (sourceCounts.get(a.id) ?? 0);
    if (sources !== 0) return sources;
    const precision = Number(b.date_precision === 'day') - Number(a.date_precision === 'day');
    if (precision !== 0) return precision;
    return a.created_at.localeCompare(b.created_at);
  })[0];
}

async function mergePass(releases: ReleaseRow[], sourceCounts: Map<string, number>) {
  const byGroup = new Map<string, ReleaseRow[]>();
  for (const row of releases) {
    const groupKey = `${row.artist_id}:${row.match_key}`;
    const bucket = byGroup.get(groupKey);
    if (bucket) bucket.push(row);
    else byGroup.set(groupKey, [row]);
  }

  let merged = 0;
  let skippedByDate = 0;
  let refused = 0;
  let groups = 0;

  for (const group of byGroup.values()) {
    if (group.length < 2) continue;
    if (groups >= LIMIT) break;

    const keeper = pickKeeper(group, sourceCounts);
    const others = group.filter(r => r.id !== keeper.id);
    let touchedGroup = false;

    for (const other of others) {
      // The one thing that overrules an identical title. Two records genuinely can share a
      // name; two records released on different days are not the same record.
      if (releaseDatesDisagree(dateFacts(keeper), dateFacts(other))) {
        skippedByDate++;
        console.log(
          `  keep  ${artistName(other)} — "${keeper.title}" ${keeper.release_date ?? 'undated'} ` +
          `vs "${other.title}" ${other.release_date ?? 'undated'} (dates disagree)`
        );
        continue;
      }

      touchedGroup = true;
      const label =
        `${artistName(other)} — "${other.title}" [${other.release_type}] into ` +
        `"${keeper.title}" [${keeper.release_type}] (${keeper.release_date ?? 'undated'})`;

      if (!WRITE) {
        console.log(`  merge ${label}`);
        merged++;
        continue;
      }

      const result = await mergeReleases(keeper.id, other.id);
      if (result.ok) {
        console.log(`  merged ${label}`);
        merged++;
      } else {
        console.log(`  REFUSED ${label} — ${result.error}`);
        refused++;
      }
    }

    if (touchedGroup) groups++;
  }

  console.log(
    `\nmerge pass: ${merged} ${WRITE ? 'merged' : 'would merge'}, ` +
    `${skippedByDate} left apart by their dates, ${refused} refused`
  );
}

async function flagPass(releases: ReleaseRow[]) {
  const byId = new Map(releases.map(r => [r.id, r]));
  const resolved = new Set<string>();
  let cleared = 0;

  for (const row of releases) {
    if (!row.needs_review || resolved.has(row.id)) continue;
    const counterpart = row.flagged_against_release_id ? byId.get(row.flagged_against_release_id) : null;
    if (!counterpart) continue;
    if (!releaseDatesDisagree(dateFacts(row), dateFacts(counterpart))) continue;

    resolved.add(row.id);
    resolved.add(counterpart.id);
    const label =
      `${artistName(row)} — "${row.title}" ${row.release_date} vs ` +
      `"${counterpart.title}" ${counterpart.release_date}`;

    if (!WRITE) {
      console.log(`  clear ${label}`);
      cleared++;
      continue;
    }

    // Exactly what an admin clicking "these are different" does, and for the same reason: the
    // dates already answered the question the flag was asking.
    if (await dismissReleaseReview(row.id)) {
      console.log(`  cleared ${label}`);
      cleared++;
    } else {
      console.log(`  FAILED to clear ${label}`);
    }
  }

  console.log(`\nreview-flag pass: ${cleared} pairs ${WRITE ? 'cleared' : 'would be cleared'}`);
}

async function main() {
  if (!WRITE) {
    console.log('DRY RUN — nothing will be written. Re-run with --write to apply.');
    // Worth saying: a dry run can't discover a refusal, because the guards that produce one
    // live inside `mergeReleases` and it is never called. Treat the merge count as an upper
    // bound, and the refusals as unknown rather than zero.
    console.log('Refusals are only discoverable with --write; the merge count here is an upper bound.\n');
  }

  const releases = await readAll<ReleaseRow>(
    'releases',
    'id, artist_id, title, match_key, release_type, release_date, date_precision, created_at,' +
    ' needs_review, flagged_against_release_id, artists ( name )'
  );
  const sources = await readAll<{ release_id: string }>('release_sources', 'id, release_id');

  const sourceCounts = new Map<string, number>();
  for (const s of sources) sourceCounts.set(s.release_id, (sourceCounts.get(s.release_id) ?? 0) + 1);

  console.log(`${releases.length} releases, ${sources.length} sources\n`);

  if (!FLAGS_ONLY) await mergePass(releases, sourceCounts);
  // Runs against the same snapshot the merge pass read, which is safe rather than lucky: this
  // pass only touches pairs whose dates disagree, and a pair whose dates disagree is exactly
  // what the merge pass refuses to merge. The two can't reach the same rows.
  if (!MERGES_ONLY) await flagPass(releases);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
