/**
 * Review and merge duplicate artist rows.
 *
 * The same artist can hold two rows with two slugs and two pages — one of them often a near-empty
 * shadow of a claimed profile. See api/functions/artist-merge.ts for how they arise.
 *
 * Usage:
 *   npx tsx scripts/merge-duplicate-artists.ts list
 *   npx tsx scripts/merge-duplicate-artists.ts merge --all           # dry run
 *   npx tsx scripts/merge-duplicate-artists.ts merge --all --apply
 *   npx tsx scripts/merge-duplicate-artists.ts merge <winnerSlug> <loserSlug> [--apply] [--force]
 *   npx tsx scripts/merge-duplicate-artists.ts reslug [--apply]
 *
 * Dry run is the default everywhere; `--apply` is the only thing that writes. `--all` merges only
 * pairs that have evidence and no blockers — never a name-only lookalike, because `Tiger Cub` and
 * `Tigercub` are different bands and so are `Honeycrush` and `Honey Crush`. Merging one of those
 * puts an artist's links on someone else's page.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY (or a .env at the repo root).
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'path';
import {
  dismissArtistDuplicatePair,
  findDuplicateArtistPairs,
  findReslugCandidates,
  mergeArtistPair,
  reslugArtist,
  restoreArtistDuplicatePair,
  type DuplicatePair,
} from '../api/functions/artist-merge';

config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Set them in .env or environment.');
  process.exit(1);
}
const client = createClient(url, key);

const argv = process.argv.slice(2);
const command = argv[0];
const apply = argv.includes('--apply');
const force = argv.includes('--force');
const positional = argv.slice(1).filter(a => !a.startsWith('--'));

function describe(pair: DuplicatePair): string {
  const row = (r: DuplicatePair['winner']) =>
    `"${r.name}" (${r.slug}, ${r.linkCount}L/${r.releaseCount}R${r.matchConfidence === 'claimed' ? ', CLAIMED' : ''}${r.hasProfile ? ', profile' : ''})`;
  const blockers = pair.blockers.length ? `\n      BLOCKED: ${pair.blockers.join('; ')}` : '';
  const shared = pair.sharedTitles.length
    ? `\n      shared titles: ${pair.sharedTitles.slice(0, 4).join(', ')}`
    : '';
  return `  [${pair.evidence}]\n      keep ${row(pair.winner)}\n      drop ${row(pair.loser)}${shared}${blockers}`;
}

async function list() {
  const result = await findDuplicateArtistPairs(client);
  if (!result.ok) { console.error(result.reason); process.exit(1); }

  const active = result.pairs.filter(p => !p.dismissed);
  const ignored = result.pairs.filter(p => p.dismissed);
  const mergeable = active.filter(p => p.evidence !== 'name-only' && p.blockers.length === 0);
  const needsReview = active.filter(p => p.evidence === 'name-only' || p.blockers.length > 0);

  console.log(`${result.pairs.length} duplicate pairs (${ignored.length} marked as different artists)\n`);
  console.log(`MERGEABLE — evidence, no blockers (${mergeable.length}):`);
  for (const p of mergeable) console.log(describe(p));
  console.log(`\nNEEDS A HUMAN (${needsReview.length}):`);
  for (const p of needsReview) console.log(describe(p));

  if (ignored.length > 0) {
    console.log(`\nMARKED AS DIFFERENT ARTISTS (${ignored.length}) — 'unignore' puts one back:`);
    for (const p of ignored) {
      console.log(`  ${p.winner.slug} / ${p.loser.slug}${p.dismissal?.note ? ` — ${p.dismissal.note}` : ''}`);
    }
  }

  const reslugs = await findReslugCandidates(client);
  if (reslugs.ok) {
    console.log(`\nRE-SLUG candidates (${reslugs.candidates.length}); ${reslugs.skippedChosen} slugs left alone because an artist chose them:`);
    for (const c of reslugs.candidates) console.log(`  "${c.name}"  ${c.from} -> ${c.to}`);
  }
}

async function merge() {
  const result = await findDuplicateArtistPairs(client);
  if (!result.ok) { console.error(result.reason); process.exit(1); }

  let targets: DuplicatePair[];
  if (argv.includes('--all')) {
    targets = result.pairs.filter(p => p.evidence !== 'name-only' && p.blockers.length === 0);
  } else {
    const [winnerSlug, loserSlug] = positional;
    if (!winnerSlug || !loserSlug) {
      console.error('Usage: merge <winnerSlug> <loserSlug> [--apply] [--force]   (or merge --all)');
      process.exit(1);
    }
    const found = result.pairs.find(
      p => (p.winner.slug === winnerSlug && p.loser.slug === loserSlug)
        || (p.winner.slug === loserSlug && p.loser.slug === winnerSlug),
    );
    if (!found) { console.error(`No current duplicate pair for ${winnerSlug} / ${loserSlug}`); process.exit(1); }
    // Respect the direction the caller asked for.
    targets = [found.winner.slug === winnerSlug ? found : { ...found, winner: found.loser, loser: found.winner }];
  }

  console.log(apply ? `APPLYING ${targets.length} merge(s)\n` : `DRY RUN — ${targets.length} merge(s), pass --apply to write\n`);
  let merged = 0;
  for (const pair of targets) {
    const r = await mergeArtistPair(client, pair, { dryRun: !apply, force });
    const label = `${pair.loser.slug} -> ${pair.winner.slug}`;
    if (!r.ok) { console.log(`  SKIP  ${label}\n        ${r.refused}`); continue; }
    merged++;
    console.log(`  ${apply ? 'OK  ' : 'WOULD'}  ${label}  [${r.evidence}]`);
    for (const s of r.steps) console.log(`           ${s.table}: ${s.action} x${s.count}`);
  }
  console.log(`\n${apply ? 'merged' : 'would merge'} ${merged} of ${targets.length}`);
}

async function reslug() {
  const result = await findReslugCandidates(client);
  if (!result.ok) { console.error(result.reason); process.exit(1); }

  console.log(apply ? `APPLYING ${result.candidates.length} re-slug(s)\n` : `DRY RUN — ${result.candidates.length} re-slug(s), pass --apply to write\n`);
  console.log(`(${result.skippedChosen} rows skipped: an artist chose that slug, so changing it would break a URL they share)\n`);
  for (const c of result.candidates) {
    const r = await reslugArtist(client, c, { dryRun: !apply });
    if (!r.ok) { console.log(`  SKIP  ${c.from} -> ${c.to}\n        ${r.refused}`); continue; }
    console.log(`  ${apply ? 'OK  ' : 'WOULD'}  "${c.name}"  ${c.from} -> ${c.to}`);
  }
}

/** Record that two same-named artists are different, so `list` stops showing them. */
async function ignore(restoreInstead: boolean) {
  const [slugA, slugB] = positional;
  if (!slugA || !slugB) {
    console.error(`Usage: ${restoreInstead ? 'unignore' : 'ignore'} <slugA> <slugB> [--note "reason"]`);
    process.exit(1);
  }
  const result = await findDuplicateArtistPairs(client);
  if (!result.ok) { console.error(result.reason); process.exit(1); }

  const pair = result.pairs.find(
    p => (p.winner.slug === slugA && p.loser.slug === slugB)
      || (p.winner.slug === slugB && p.loser.slug === slugA),
  );
  if (!pair) { console.error(`No duplicate pair for ${slugA} / ${slugB}`); process.exit(1); }

  const noteIndex = argv.indexOf('--note');
  const note = noteIndex > -1 ? argv[noteIndex + 1] : undefined;

  const r = restoreInstead
    ? await restoreArtistDuplicatePair(client, pair.winner.id, pair.loser.id)
    : await dismissArtistDuplicatePair(client, pair.winner.id, pair.loser.id, { note, dismissedBy: 'cli' });

  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(restoreInstead
    ? `${slugA} / ${slugB} back in the review queue`
    : `${slugA} / ${slugB} marked as different artists${note ? ` — ${note}` : ''}`);
}

switch (command) {
  case 'list': await list(); break;
  case 'merge': await merge(); break;
  case 'reslug': await reslug(); break;
  case 'ignore': await ignore(false); break;
  case 'unignore': await ignore(true); break;
  default:
    console.error(
      'Usage: list | merge [--all | <winnerSlug> <loserSlug>] [--apply] [--force] | reslug [--apply]\n' +
      '     | ignore <slugA> <slugB> [--note "reason"] | unignore <slugA> <slugB>');
    process.exit(1);
}
