// Merge duplicate artist rows, and re-slug rows whose slug was mangled before accent folding.
//
// ## Why duplicates exist
//
// Three separate causes, measured on production 2026-08-03 (27 pairs):
//
//   1. **Machine-key names** (9 pairs). Until PR #338, `attachNameOnlyPlatforms` fell back to
//      `|| normalizedName` when a name-only platform hit had no display name, so the artist was
//      named after the normalized map key — `kidlightbulbs` alongside `Kid Lightbulbs`. Dead cause.
//   2. **Spelling disagreement between sources** (13 pairs). MusicBrainz says "Big Thief", another
//      platform says "Bigthief"; each spelling produces a different `artistSlug`, so each gets a row.
//      Still live.
//   3. **Accent mangling** (5 pairs). `artistSlug` used to turn `Björk` into `bj-rk`. Fixed, but the
//      rows remain.
//
// Five pairs shadow a *claimed* profile, which is what makes this user-visible: the artist owns one
// URL and a stranger's search created a second, thinner one.
//
// ## Why a pair being name-similar is NOT enough to merge it
//
// `Tiger Cub` and `Tigercub` are different bands — zero shared release titles, measured. So are
// `Honeycrush` (Brooklyn) and `Honey Crush` (Orlando), which an earlier fix deliberately separated.
// Merging on name similarity would put one artist's links on another's page, which is the exact
// failure that fix existed to prevent. So every merge here requires **evidence**, and the evidence
// is recorded on the result so a human can audit what was trusted.

import type { SupabaseClient } from '@supabase/supabase-js';
import { artistSlug } from './db';
import { foldToAscii, normalizeForComparison } from './search-utils';

/** Why we believe two rows are the same artist. */
export type MergeEvidence =
  /** The loser's name is exactly the normalized form of the winner's — the #338 bug made it. */
  | 'provenance'
  /** The two rows share at least one release title. */
  | 'release-overlap'
  /**
   * The two names are identical once accents are folded — "Björk"/"Bjork",
   * "Sébastien Tellier"/"Sebastien Tellier". Two sources spelled one artist two ways.
   *
   * Mechanical, not a guess, and it excludes the case that looks similar but isn't: `foldToAscii`
   * maps "Błoto" to "Bloto", which is *not* "Boto", so that pair stays unmerged.
   */
  | 'accent-fold'
  /** Names look alike and nothing else corroborates it. Never merged without an explicit override. */
  | 'name-only';

/** True when `name` looks like the output of normalizeForComparison rather than a real name. */
function isMachineKeyName(name: string, other: string): boolean {
  return name === normalizeForComparison(other) && name !== other;
}

export interface DuplicateRow {
  id: string;
  slug: string;
  name: string;
  matchConfidence: string;
  linkCount: number;
  releaseCount: number;
  hasProfile: boolean;
  analyticsCount: number;
}

export interface DuplicatePair {
  /** normalizeForComparison of the shared name. */
  key: string;
  winner: DuplicateRow;
  loser: DuplicateRow;
  evidence: MergeEvidence;
  /** Shared normalized release titles, when that's the evidence. */
  sharedTitles: string[];
  /**
   * Reasons this pair must not be merged automatically even if evidence is strong. A merge with any
   * blocker set is refused unless the caller passes `force`.
   */
  blockers: string[];
  /**
   * A human has confirmed these are different artists. Still returned, not dropped, so the decision
   * can be seen and undone — a one-way hide would mean a mis-click silently loses a real duplicate.
   */
  dismissed: boolean;
  /** Why they were dismissed, and by whom. Null unless `dismissed`. */
  dismissal: { note: string | null; dismissedBy: string | null; at: string } | null;
}

/**
 * The canonical key for a dismissal row: ids sorted, because the table enforces `a < b` so a pair has
 * exactly one representation and a lookup never has to try both orders.
 */
export function dismissalKey(idA: string, idB: string): { artist_id_a: string; artist_id_b: string } {
  return idA < idB
    ? { artist_id_a: idA, artist_id_b: idB }
    : { artist_id_a: idB, artist_id_b: idA };
}

/**
 * Pick the surviving row: **claimed wins, else more links.**
 *
 * Claimed first because the artist owns that URL and has likely shared it; link count second as a
 * proxy for which row search has actually populated. This only chooses a winner — it says nothing
 * about whether the pair is really one artist. That's `evidence`.
 */
function pickWinner(a: DuplicateRow, b: DuplicateRow): [DuplicateRow, DuplicateRow] {
  const aClaimed = a.matchConfidence === 'claimed';
  const bClaimed = b.matchConfidence === 'claimed';
  if (aClaimed !== bClaimed) return aClaimed ? [a, b] : [b, a];

  // A machine-key name must never survive. Ahead of link count, because when both rows have one link
  // the count decides nothing and the id tiebreak was picking rows literally named
  // "snapinfractionfeatmadeline" and "controlfreakstudio" over the real names. It also has to run
  // before classify(), which recognises provenance by the *loser* carrying the normalized form.
  const aIsKey = isMachineKeyName(a.name, b.name);
  const bIsKey = isMachineKeyName(b.name, a.name);
  if (aIsKey !== bIsKey) return aIsKey ? [b, a] : [a, b];

  if (a.linkCount !== b.linkCount) return a.linkCount > b.linkCount ? [a, b] : [b, a];
  // Stable tiebreak so repeated runs agree with each other.
  return a.id < b.id ? [a, b] : [b, a];
}

function classify(
  winner: DuplicateRow,
  loser: DuplicateRow,
  winnerTitles: Set<string>,
  loserTitles: Set<string>,
): { evidence: MergeEvidence; sharedTitles: string[] } {
  // The machine-key signature: the loser's name IS the normalized winner name. Nothing else
  // produces that, so the pair is the same artist by construction.
  if (isMachineKeyName(loser.name, winner.name)) {
    return { evidence: 'provenance', sharedTitles: [] };
  }
  const shared = [...loserTitles].filter(t => winnerTitles.has(t));
  if (shared.length > 0) return { evidence: 'release-overlap', sharedTitles: shared };

  // Identical once accents fold: two sources spelled one artist two ways. This is the case fans
  // actually reported — searching "bjork" landed them on the 1-link `Bjork` stub instead of `Björk`.
  // Note foldToAscii, not normalizeForComparison: folding keeps "Błoto" as "Bloto" so it does NOT
  // equal "Boto", which is how that genuinely-different pair stays out of this class.
  const fold = (s: string) => foldToAscii(s).toLowerCase();
  if (fold(winner.name) === fold(loser.name) && winner.name !== loser.name) {
    return { evidence: 'accent-fold', sharedTitles: [] };
  }

  return { evidence: 'name-only', sharedTitles: [] };
}

/**
 * Every pair of artist rows whose names normalize to the same string, with the evidence for merging
 * and anything that blocks it.
 *
 * Reads page by page: `artists` is ~3,400 rows and `artist_links` ~16,800, and PostgREST silently
 * caps a response at 1,000 whatever limit is asked for.
 */
export async function findDuplicateArtistPairs(
  client: SupabaseClient,
): Promise<{ ok: true; pairs: DuplicatePair[] } | { ok: false; reason: string }> {
  const read = async <T>(table: string, columns: string, order: string): Promise<T[] | null> => {
    const rows: T[] = [];
    for (let from = 0; from < 50_000; from += 1_000) {
      const { data, error } = await client
        .from(table)
        .select(columns)
        .order(order)
        .range(from, from + 999);
      if (error) {
        console.error(`[merge] failed reading ${table}:`, error.message);
        return null;
      }
      const batch = (data as T[]) ?? [];
      rows.push(...batch);
      if (batch.length < 1_000) return rows;
    }
    return rows;
  };

  const artists = await read<{ id: string; slug: string; name: string; match_confidence: string }>(
    'artists', 'id, slug, name, match_confidence', 'id');
  if (!artists) return { ok: false, reason: 'Could not read artists' };

  const links = await read<{ artist_id: string }>('artist_links', 'artist_id', 'id');
  if (!links) return { ok: false, reason: 'Could not read artist_links' };

  const releases = await read<{ artist_id: string; match_key: string }>(
    'releases', 'artist_id, match_key', 'id');
  if (!releases) return { ok: false, reason: 'Could not read releases' };

  const profiles = await read<{ artist_id: string }>('artist_profiles', 'artist_id', 'artist_id');
  if (!profiles) return { ok: false, reason: 'Could not read artist_profiles' };

  const analytics = await read<{ artist_id: string }>('artist_analytics', 'artist_id', 'artist_id');
  if (!analytics) return { ok: false, reason: 'Could not read artist_analytics' };

  const dismissals = await read<{
    artist_id_a: string; artist_id_b: string; note: string | null; dismissed_by: string | null; created_at: string;
  }>('artist_duplicate_dismissals', 'artist_id_a, artist_id_b, note, dismissed_by, created_at', 'artist_id_a');
  if (!dismissals) return { ok: false, reason: 'Could not read artist_duplicate_dismissals' };

  const dismissedBy = new Map(
    dismissals.map(d => [`${d.artist_id_a}|${d.artist_id_b}`, d]),
  );

  const count = (rows: { artist_id: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.artist_id, (m.get(r.artist_id) ?? 0) + 1);
    return m;
  };
  const linkCounts = count(links);
  const analyticsCounts = count(analytics);
  const profileIds = new Set(profiles.map(p => p.artist_id));
  const titles = new Map<string, Set<string>>();
  for (const r of releases) {
    if (!titles.has(r.artist_id)) titles.set(r.artist_id, new Set());
    titles.get(r.artist_id)!.add(r.match_key);
  }

  const toRow = (a: { id: string; slug: string; name: string; match_confidence: string }): DuplicateRow => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    matchConfidence: a.match_confidence,
    linkCount: linkCounts.get(a.id) ?? 0,
    releaseCount: titles.get(a.id)?.size ?? 0,
    hasProfile: profileIds.has(a.id),
    analyticsCount: analyticsCounts.get(a.id) ?? 0,
  });

  const groups = new Map<string, DuplicateRow[]>();
  for (const a of artists) {
    const key = normalizeForComparison(a.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(toRow(a));
  }

  const pairs: DuplicatePair[] = [];
  for (const [key, rows] of groups) {
    if (rows.length !== 2) continue; // three-way collisions need a human, not a rule
    const [winner, loser] = pickWinner(rows[0], rows[1]);
    const { evidence, sharedTitles } = classify(
      winner, loser, titles.get(winner.id) ?? new Set(), titles.get(loser.id) ?? new Set());

    const blockers: string[] = [];
    // Both claimed: two people may each believe they own this artist. Never guess.
    if (winner.matchConfidence === 'claimed' && loser.matchConfidence === 'claimed') {
      blockers.push('both rows are claimed');
    }
    // artist_profiles is UNIQUE(artist_id), so merging discards one profile's edits outright.
    if (winner.hasProfile && loser.hasProfile) {
      blockers.push('both rows have an artist_profiles row — one artist’s edits would be discarded');
    }
    // Both sides have releases and none match: positive evidence they are DIFFERENT artists.
    if (winner.releaseCount > 0 && loser.releaseCount > 0 && sharedTitles.length === 0) {
      blockers.push('both rows have releases and share none — probably different artists');
    }
    const dk = dismissalKey(winner.id, loser.id);
    const dismissal = dismissedBy.get(`${dk.artist_id_a}|${dk.artist_id_b}`);

    pairs.push({
      key, winner, loser, evidence, sharedTitles, blockers,
      dismissed: !!dismissal,
      dismissal: dismissal
        ? { note: dismissal.note, dismissedBy: dismissal.dismissed_by, at: dismissal.created_at }
        : null,
    });
  }

  // Dismissed last — they are settled. Then mergeable, then by how much is at stake.
  pairs.sort((a, b) => {
    const rank = (p: DuplicatePair) =>
      p.dismissed ? 3 : p.blockers.length > 0 ? 2 : p.evidence === 'name-only' ? 1 : 0;
    return rank(a) - rank(b) || b.loser.linkCount - a.loser.linkCount;
  });

  return { ok: true, pairs };
}

/**
 * Record that two same-named artists are different artists, so the review queue stops listing them.
 *
 * Idempotent: dismissing twice is a no-op rather than an error, because the admin page can be open in
 * two tabs and a duplicate click should not surface a constraint violation.
 */
export async function dismissArtistDuplicatePair(
  client: SupabaseClient,
  artistIdA: string,
  artistIdB: string,
  opts: { note?: string | null; dismissedBy?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (artistIdA === artistIdB) return { ok: false, error: 'An artist cannot be dismissed against itself' };

  const { error } = await client
    .from('artist_duplicate_dismissals')
    .upsert(
      {
        ...dismissalKey(artistIdA, artistIdB),
        note: opts.note ?? null,
        dismissed_by: opts.dismissedBy ?? null,
      },
      { onConflict: 'artist_id_a,artist_id_b' },
    );

  if (error) {
    console.error('[merge] failed to dismiss pair:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Undo a dismissal, putting the pair back in the review queue. */
export async function restoreArtistDuplicatePair(
  client: SupabaseClient,
  artistIdA: string,
  artistIdB: string,
): Promise<{ ok: boolean; error?: string }> {
  // One `.match()` rather than two chained `.eq()` — the key is composite, so this reads as the
  // single lookup it is.
  const { error } = await client
    .from('artist_duplicate_dismissals')
    .delete()
    .match(dismissalKey(artistIdA, artistIdB));

  if (error) {
    console.error('[merge] failed to restore pair:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export interface MergeStep {
  table: string;
  action: string;
  count: number;
}

export interface MergeResult {
  ok: boolean;
  dryRun: boolean;
  winner: { id: string; slug: string; name: string };
  loser: { id: string; slug: string; name: string };
  evidence: MergeEvidence;
  steps: MergeStep[];
  /** Set when the merge was refused. */
  refused?: string;
}

/**
 * Move everything from `loser` onto `winner`, alias the loser's slug, and delete the loser row.
 *
 * Order matters: every reassignment happens before the delete, so a failure part-way leaves the
 * loser row in place and the merge can simply be re-run. `dryRun` reports the same step list without
 * writing, and is the default for every caller.
 *
 * The seven tables carrying `artist_id`, and what each needs:
 *   artist_links           UNIQUE(artist_id, platform) — the winner's link wins a platform clash
 *   artist_analytics       plain reassign; history from both rows should sum
 *   artist_profiles        UNIQUE(artist_id) — only moves when the winner has none
 *   release_catalog_state  UNIQUE(artist_id) — derived crawl state, the loser's is dropped
 *   releases               UNIQUE(artist_id, slug) — only titles the winner lacks move over
 *   saved_artists          no FK, keyed by (user_id, artist_slug) — the SLUG must be rewritten
 *   verification_requests  plain reassign
 */
export async function mergeArtistPair(
  client: SupabaseClient,
  pair: DuplicatePair,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<MergeResult> {
  const dryRun = opts.dryRun !== false;
  const { winner, loser, evidence } = pair;
  const base: MergeResult = {
    ok: false,
    dryRun,
    winner: { id: winner.id, slug: winner.slug, name: winner.name },
    loser: { id: loser.id, slug: loser.slug, name: loser.name },
    evidence,
    steps: [],
  };

  if (winner.id === loser.id) return { ...base, refused: 'winner and loser are the same row' };
  // A human already decided these are different artists. Refuse even under `force`: force exists to
  // override the *automatic* checks, not a recorded human decision. Restore the pair first — that is
  // an explicit, visible step, whereas silently merging over a dismissal would make the review
  // queue's own record untrustworthy.
  if (pair.dismissed) {
    return {
      ...base,
      refused: 'this pair was dismissed as different artists — restore it first if that was wrong',
    };
  }
  if (pair.blockers.length > 0 && !opts.force) {
    return { ...base, refused: `blocked: ${pair.blockers.join('; ')}` };
  }
  if (evidence === 'name-only' && !opts.force) {
    return {
      ...base,
      refused:
        'no evidence beyond name similarity — Tiger Cub/Tigercub and Honeycrush/Honey Crush are ' +
        'genuinely different artists that look like this',
    };
  }

  const steps: MergeStep[] = [];
  const note = (table: string, action: string, count: number) => {
    if (count > 0) steps.push({ table, action, count });
  };

  // --- artist_links: move only platforms the winner doesn't already have.
  const { data: loserLinks } = await client
    .from('artist_links').select('id, platform').eq('artist_id', loser.id);
  const { data: winnerLinks } = await client
    .from('artist_links').select('platform').eq('artist_id', winner.id);
  const held = new Set((winnerLinks ?? []).map((l: { platform: string }) => l.platform));
  const movableLinks = (loserLinks ?? []).filter((l: { platform: string }) => !held.has(l.platform));
  note('artist_links', 'reassign', movableLinks.length);
  note('artist_links', 'drop (winner already has the platform)',
    (loserLinks ?? []).length - movableLinks.length);
  if (!dryRun && movableLinks.length > 0) {
    const { error } = await client.from('artist_links')
      .update({ artist_id: winner.id })
      .in('id', movableLinks.map((l: { id: string }) => l.id));
    if (error) return { ...base, steps, refused: `artist_links: ${error.message}` };
  }

  // --- releases: move only titles the winner lacks, so a shared catalogue isn't duplicated.
  const { data: loserReleases } = await client
    .from('releases').select('id, match_key').eq('artist_id', loser.id);
  const { data: winnerReleases } = await client
    .from('releases').select('match_key').eq('artist_id', winner.id);
  const winnerKeys = new Set((winnerReleases ?? []).map((r: { match_key: string }) => r.match_key));
  const movableReleases = (loserReleases ?? [])
    .filter((r: { match_key: string }) => !winnerKeys.has(r.match_key));
  note('releases', 'reassign', movableReleases.length);
  note('releases', 'drop (winner already has the title)',
    (loserReleases ?? []).length - movableReleases.length);
  if (!dryRun && movableReleases.length > 0) {
    const { error } = await client.from('releases')
      .update({ artist_id: winner.id })
      .in('id', movableReleases.map((r: { id: string }) => r.id));
    if (error) return { ...base, steps, refused: `releases: ${error.message}` };
  }

  // --- artist_analytics: all of it, so the surviving dashboard keeps both rows' history.
  //
  // Counted fresh rather than read off `pair.loser.analyticsCount`. That snapshot is taken when the
  // pair list is built, which for the admin page is whenever it last loaded — minutes or hours
  // before the merge is clicked. Gating the write on a stale zero would silently drop history.
  const { data: loserAnalytics } = await client
    .from('artist_analytics').select('id').eq('artist_id', loser.id);
  note('artist_analytics', 'reassign', (loserAnalytics ?? []).length);
  if (!dryRun && (loserAnalytics ?? []).length > 0) {
    const { error } = await client.from('artist_analytics')
      .update({ artist_id: winner.id }).eq('artist_id', loser.id);
    if (error) return { ...base, steps, refused: `artist_analytics: ${error.message}` };
  }

  // --- artist_profiles / release_catalog_state: UNIQUE(artist_id), so at most one can survive.
  for (const table of ['artist_profiles', 'release_catalog_state'] as const) {
    const { data: onWinner } = await client
      .from(table).select('artist_id').eq('artist_id', winner.id).maybeSingle();
    const { data: onLoser } = await client
      .from(table).select('artist_id').eq('artist_id', loser.id).maybeSingle();
    if (!onLoser) continue;
    if (onWinner) {
      // Dropped rather than merged. For release_catalog_state that's harmless — it's crawl
      // bookkeeping the next run rebuilds. For artist_profiles it is NOT, which is why two profiles
      // is a blocker above and this line is only reachable under `force`.
      note(table, 'delete loser row (winner already has one)', 1);
      if (!dryRun) await client.from(table).delete().eq('artist_id', loser.id);
    } else {
      note(table, 'reassign', 1);
      if (!dryRun) {
        const { error } = await client.from(table)
          .update({ artist_id: winner.id }).eq('artist_id', loser.id);
        if (error) return { ...base, steps, refused: `${table}: ${error.message}` };
      }
    }
  }

  // --- verification_requests: plain reassign.
  const { data: vr } = await client
    .from('verification_requests').select('id').eq('artist_id', loser.id);
  note('verification_requests', 'reassign', (vr ?? []).length);
  if (!dryRun && (vr ?? []).length > 0) {
    await client.from('verification_requests')
      .update({ artist_id: winner.id }).eq('artist_id', loser.id);
  }

  // --- saved_artists: keyed by (user_id, artist_slug) with NO foreign key, and artist_id is
  // ON DELETE SET NULL. So deleting the loser would leave a save pointing at a dead slug rather
  // than following the merge — the slug has to be rewritten, and a user who saved both rows would
  // collide on the unique index, so their loser-side save is dropped.
  const { data: loserSaves } = await client
    .from('saved_artists').select('id, user_id').eq('artist_slug', loser.slug);
  const { data: winnerSaves } = await client
    .from('saved_artists').select('user_id').eq('artist_slug', winner.slug);
  const savedWinner = new Set((winnerSaves ?? []).map((s: { user_id: string }) => s.user_id));
  const movableSaves = (loserSaves ?? []).filter((s: { user_id: string }) => !savedWinner.has(s.user_id));
  const collidingSaves = (loserSaves ?? []).filter((s: { user_id: string }) => savedWinner.has(s.user_id));
  note('saved_artists', 'repoint slug at the winner', movableSaves.length);
  note('saved_artists', 'delete (user had already saved the winner)', collidingSaves.length);
  if (!dryRun) {
    if (movableSaves.length > 0) {
      const { error } = await client.from('saved_artists')
        .update({ artist_slug: winner.slug, artist_id: winner.id })
        .in('id', movableSaves.map((s: { id: string }) => s.id));
      if (error) return { ...base, steps, refused: `saved_artists: ${error.message}` };
    }
    if (collidingSaves.length > 0) {
      await client.from('saved_artists').delete()
        .in('id', collidingSaves.map((s: { id: string }) => s.id));
    }
  }

  // --- Alias the loser's slug BEFORE deleting the row, so the URL never has a gap.
  note('artist_slug_aliases', `alias ${loser.slug} -> ${winner.slug}`, 1);
  if (!dryRun) {
    const { error } = await client.from('artist_slug_aliases')
      .upsert({ alias: loser.slug, artist_id: winner.id, reason: 'merge' }, { onConflict: 'alias' });
    if (error) return { ...base, steps, refused: `artist_slug_aliases: ${error.message}` };
  }

  // --- Finally the loser row. Anything still pointing at it cascades away, which is why every
  // reassignment above happens first.
  note('artists', 'delete loser row', 1);
  if (!dryRun) {
    const { error } = await client.from('artists').delete().eq('id', loser.id);
    if (error) return { ...base, steps, refused: `artists: ${error.message}` };
  }

  return { ...base, ok: true, steps };
}

export interface ReslugCandidate {
  id: string;
  name: string;
  from: string;
  to: string;
}

/**
 * The **old** artistSlug, kept only to tell a machine-generated slug from one a human chose.
 *
 * If a row's stored slug equals this, nothing but code produced it and it is safe to replace. If it
 * differs, somebody picked it — `muz4now`, `boezi`, `courstellation`, `cbertine` — and re-slugging
 * would break a URL the artist shares. Measured 2026-08-03: 41 rows compute a different slug under
 * accent folding, but only 17 pass this test; 11 of the other 24 are claimed profiles.
 */
function legacyArtistSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Rows whose slug is a mangled artifact of the pre-folding artistSlug, and what it should become. */
export async function findReslugCandidates(
  client: SupabaseClient,
): Promise<{ ok: true; candidates: ReslugCandidate[]; skippedChosen: number } | { ok: false; reason: string }> {
  const rows: { id: string; slug: string; name: string }[] = [];
  for (let from = 0; from < 50_000; from += 1_000) {
    const { data, error } = await client
      .from('artists').select('id, slug, name').order('id').range(from, from + 999);
    if (error) return { ok: false, reason: `Could not read artists: ${error.message}` };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < 1_000) break;
  }

  const candidates: ReslugCandidate[] = [];
  let skippedChosen = 0;
  for (const row of rows) {
    const target = artistSlug(row.name);
    if (!target || target === row.slug) continue;
    if (legacyArtistSlug(row.name) !== row.slug) {
      skippedChosen++; // a human picked this slug
      continue;
    }
    candidates.push({ id: row.id, name: row.name, from: row.slug, to: target });
  }
  return { ok: true, candidates, skippedChosen };
}

/**
 * Move a row to its folded slug, aliasing the old one.
 *
 * Refuses when the target slug is already held by another row — that means the accent duplicate is
 * still there and must be merged first, which frees the slug.
 */
export async function reslugArtist(
  client: SupabaseClient,
  candidate: ReslugCandidate,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: boolean; dryRun: boolean; candidate: ReslugCandidate; refused?: string }> {
  const dryRun = opts.dryRun !== false;
  const result = { ok: false, dryRun, candidate };

  const { data: holder } = await client
    .from('artists').select('id, name').eq('slug', candidate.to).maybeSingle();
  if (holder && (holder as { id: string }).id !== candidate.id) {
    return { ...result, refused: `slug "${candidate.to}" is held by "${(holder as { name: string }).name}" — merge that pair first` };
  }
  if (dryRun) return { ...result, ok: true };

  const { error: aliasError } = await client.from('artist_slug_aliases')
    .upsert({ alias: candidate.from, artist_id: candidate.id, reason: 'reslug' }, { onConflict: 'alias' });
  if (aliasError) return { ...result, refused: `alias: ${aliasError.message}` };

  const { error } = await client.from('artists')
    .update({ slug: candidate.to, updated_at: new Date().toISOString() })
    .eq('id', candidate.id);
  if (error) return { ...result, refused: `artists: ${error.message}` };

  // saved_artists keys on the slug and has no FK, so a save would otherwise keep pointing at the
  // old one. Rows whose user already holds the new slug are left alone rather than colliding.
  const { data: existing } = await client
    .from('saved_artists').select('user_id').eq('artist_slug', candidate.to);
  const taken = new Set((existing ?? []).map((s: { user_id: string }) => s.user_id));
  const { data: saves } = await client
    .from('saved_artists').select('id, user_id').eq('artist_slug', candidate.from);
  const movable = (saves ?? []).filter((s: { user_id: string }) => !taken.has(s.user_id));
  if (movable.length > 0) {
    await client.from('saved_artists')
      .update({ artist_slug: candidate.to })
      .in('id', movable.map((s: { id: string }) => s.id));
  }

  return { ...result, ok: true };
}
